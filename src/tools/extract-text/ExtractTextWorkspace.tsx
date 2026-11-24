import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  FileText,
  Play,
  RotateCw,
  ScanText,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession, type OcrQueueEntry } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  formatLocalizedError,
  getOcrEngineStatus,
  inspectOcrSources,
  isTauriDesktop,
  ocrExtractBatch,
  pickMultipleFiles,
  pickSaveFilePath,
  readClipboardImageAsAsset,
  saveLocalTextFile,
  subscribeFileDrop,
  subscribeOcrProgress,
  writeSystemClipboardText,
  type OcrBatchItemResult,
  type OcrPageResult,
  type OcrTextLine,
} from "../../lib/tauriBridge";
import "./extractText.css";

const OCR_ACCEPT_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "bmp",
  "tif",
  "tiff",
  "gif",
  "heic",
  "heif",
  "pdf",
];

function isAcceptedOcrFile(filePath: string): boolean {
  const dot = filePath.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = filePath.slice(dot + 1).toLowerCase();
  return OCR_ACCEPT_EXTENSIONS.includes(ext);
}

function makeEditKey(itemId: string, pageNumber: number): string {
  return `${itemId}::${pageNumber}`;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function ExtractTextWorkspace() {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const { pdfSession, updateExtractTextSession, pendingToolIntake, clearPendingToolIntake } =
    usePdfSession();
  const state = pdfSession.extractText;

  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [inspectBusy, setInspectBusy] = useState(false);

  const stateRef = useRef(state);
  stateRef.current = state;

  const showToast = useCallback((setter: (v: string | null) => void, msg: string) => {
    setter(msg);
    window.setTimeout(() => {
      setter(null);
    }, 2200);
  }, []);

  // Load OCR runtime status once on mount
  useEffect(() => {
    let active = true;
    getOcrEngineStatus()
      .then((status) => {
        if (!active) return;
        updateExtractTextSession((prev) => ({ ...prev, engineStatus: status }));
      })
      .catch((err) => {
        if (!active) return;
        updateExtractTextSession((prev) => ({
          ...prev,
          engineStatus: {
            ready: false,
            engineName: "RapidOCR PP-OCRv4 mobile",
            runtimeVersion: null,
            ocrDir: null,
            error: formatLocalizedError(err, t),
          },
        }));
      });
    return () => {
      active = false;
    };
  }, [t, updateExtractTextSession]);

  // Subscribe to granular OCR progress events
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeOcrProgress((payload) => {
          updateExtractTextSession((prev) => {
            if (prev.activeTaskId && payload.taskId !== prev.activeTaskId) {
              return prev;
            }
            return { ...prev, progress: payload };
          });
        }),
      "winkit://ocr-progress",
    );
  }, [updateExtractTextSession]);

  const addFilePaths = useCallback(
    async (rawPaths: string[]) => {
      const validPaths = rawPaths.filter(isAcceptedOcrFile);
      if (validPaths.length === 0) {
        updateExtractTextSession((prev) => ({
          ...prev,
          errorMessage: zh
            ? "未检测到支持的图片（PNG/JPG/WebP/BMP/TIFF/HEIC）或 PDF 文件。"
            : "No supported image (PNG/JPG/WebP/BMP/TIFF/HEIC) or PDF files were selected.",
        }));
        return;
      }
      setInspectBusy(true);
      updateExtractTextSession((prev) => ({ ...prev, errorMessage: null }));
      try {
        const inspected = await inspectOcrSources(validPaths);
        updateExtractTextSession((prev) => {
          const existingPaths = new Set(prev.queue.map((q) => q.path?.toLowerCase()));
          const additions: OcrQueueEntry[] = [];
          for (const item of inspected) {
            if (existingPaths.has(item.path.toLowerCase())) continue;
            additions.push({
              id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              kind: item.kind,
              path: item.path,
              assetId: null,
              fileName: item.fileName,
              byteLength: item.byteLength,
              widthPx: item.widthPx,
              heightPx: item.heightPx,
              pageCount: item.pageCount,
              isLikelyScanned: item.isLikelyScanned,
              pageRange: "",
              thumbnailDataUrl: item.previewDataUrl,
              inspectError: item.errorMessage,
            });
          }
          const nextQueue = [...prev.queue, ...additions];
          const nextActiveId = prev.activeItemId ?? additions[0]?.id ?? nextQueue[0]?.id ?? null;
          return {
            ...prev,
            queue: nextQueue,
            activeItemId: nextActiveId,
            activePageNumber: 1,
            selectedLineIndex: null,
          };
        });
      } catch (err) {
        updateExtractTextSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      } finally {
        setInspectBusy(false);
      }
    },
    [t, updateExtractTextSession, zh],
  );

  // Consume cross-tool PDF handoff from C08 PDF Reader
  useEffect(() => {
    if (!pendingToolIntake || pendingToolIntake.toolId !== "T03") return;
    const intakePath = pendingToolIntake.path;
    clearPendingToolIntake();
    void addFilePaths([intakePath]);
  }, [addFilePaths, clearPendingToolIntake, pendingToolIntake]);

  // Listen for desktop drag-and-drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onDropPaths: (paths) => {
            if (paths.length === 0) return;
            if (stateRef.current.taskStatus === "running") return;
            void addFilePaths(paths);
          },
        }),
      "tauri://drag-drop",
    );
  }, [addFilePaths]);

  const handleOpenFiles = useCallback(async () => {
    const list = await pickMultipleFiles({
      title: zh ? "选择图片或扫描版 PDF" : "Select Images or Scanned PDFs",
      filters: [
        {
          name: zh ? "图片与 PDF" : "Images & PDF",
          extensions: OCR_ACCEPT_EXTENSIONS,
        },
      ],
    });
    if (list.length > 0) {
      await addFilePaths(list);
    }
  }, [addFilePaths, zh]);

  const handlePasteClipboard = useCallback(async () => {
    if (stateRef.current.taskStatus === "running") return;
    updateExtractTextSession((prev) => ({ ...prev, errorMessage: null }));
    try {
      const asset = await readClipboardImageAsAsset();
      const id = `ocr-clip-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const entry: OcrQueueEntry = {
        id,
        kind: "clipboard",
        path: null,
        assetId: asset.assetId,
        fileName: zh
          ? `剪贴板图片 (${asset.width}×${asset.height})`
          : `Clipboard (${asset.width}×${asset.height})`,
        byteLength: 0,
        widthPx: asset.width,
        heightPx: asset.height,
        pageCount: 1,
        isLikelyScanned: false,
        pageRange: "",
        thumbnailDataUrl: asset.dataUrl,
        inspectError: null,
      };
      updateExtractTextSession((prev) => ({
        ...prev,
        queue: [...prev.queue, entry],
        activeItemId: id,
        activePageNumber: 1,
        selectedLineIndex: null,
      }));
    } catch (err) {
      updateExtractTextSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  }, [t, updateExtractTextSession, zh]);

  // Ctrl+V shortcut for pasting clipboard image when not typing in an input/textarea
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== "v") return;
      const target = ev.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (!isTauriDesktop()) return;
      ev.preventDefault();
      void handlePasteClipboard();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handlePasteClipboard]);

  const handleRunOcr = useCallback(
    async (mode: "pending" | "rerun-active") => {
      const cur = stateRef.current;
      if (cur.taskStatus === "running") return;

      const activeCandidate =
        cur.queue.find((q) => q.id === cur.activeItemId) ?? cur.queue[0] ?? null;

      const targets =
        mode === "rerun-active"
          ? activeCandidate && !activeCandidate.inspectError
            ? [activeCandidate]
            : []
          : cur.queue.filter(
              (item) => !item.inspectError && cur.resultsByItemId[item.id]?.status !== "completed",
            );

      if (targets.length === 0) return;

      const taskId = `t03-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      updateExtractTextSession((prev) => ({
        ...prev,
        taskStatus: "running",
        activeTaskId: taskId,
        progress: {
          taskId,
          currentItem: 1,
          totalItems: targets.length,
          currentPage: 1,
          totalPages: 1,
          label: targets[0]?.fileName ?? "",
          percent: 0,
          state: "running",
        },
        lastCancelled: false,
        errorMessage: null,
      }));

      try {
        const batchRes = await ocrExtractBatch(taskId, {
          items: targets.map((item) => ({
            id: item.id,
            path: item.path,
            assetId: item.assetId,
            name: item.fileName,
            pageRange: item.kind === "pdf" && item.pageRange.trim() ? item.pageRange.trim() : null,
          })),
          pdfDpi: cur.pdfDpi,
          options: {
            maxSideLen: cur.maxSideLen,
            includePreview: true,
          },
        });

        updateExtractTextSession((prev) => {
          const nextResults = { ...prev.resultsByItemId };
          const nextEdits = { ...prev.editedTexts };
          for (const itemRes of batchRes.items) {
            nextResults[itemRes.sourceId] = itemRes;
            if (mode === "rerun-active") {
              for (const key of Object.keys(nextEdits)) {
                if (key.startsWith(`${itemRes.sourceId}::`)) {
                  delete nextEdits[key];
                }
              }
            }
          }
          const firstDone = batchRes.items.find((it) => it.pages.length > 0);
          const nextActiveId =
            prev.activeItemId && nextResults[prev.activeItemId]?.pages.length
              ? prev.activeItemId
              : (firstDone?.sourceId ?? prev.activeItemId);
          const activePages = nextActiveId ? nextResults[nextActiveId]?.pages : undefined;
          const nextPageNum = activePages?.some((p) => p.pageNumber === prev.activePageNumber)
            ? prev.activePageNumber
            : (activePages?.[0]?.pageNumber ?? 1);

          return {
            ...prev,
            resultsByItemId: nextResults,
            editedTexts: nextEdits,
            activeItemId: nextActiveId,
            activePageNumber: nextPageNum,
            selectedLineIndex: null,
            taskStatus: "idle",
            activeTaskId: null,
            progress: null,
            lastCancelled: batchRes.cancelled,
            errorMessage:
              batchRes.failedCount > 0 && batchRes.completedCount === 0
                ? (batchRes.items.find((it) => it.errorMessage)?.errorMessage ??
                  (zh ? "离线识别失败。" : "Offline OCR failed."))
                : null,
          };
        });
      } catch (err) {
        updateExtractTextSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateExtractTextSession, zh],
  );

  const handleCancelOcr = useCallback(async () => {
    const tid = stateRef.current.activeTaskId;
    if (!tid) return;
    await cancelBackendTask(tid).catch(() => {});
  }, []);

  const handleRemoveItem = useCallback(
    (id: string) => {
      updateExtractTextSession((prev) => {
        const nextQueue = prev.queue.filter((q) => q.id !== id);
        const nextResults = { ...prev.resultsByItemId };
        delete nextResults[id];
        const nextEdits = { ...prev.editedTexts };
        for (const key of Object.keys(nextEdits)) {
          if (key.startsWith(`${id}::`)) {
            delete nextEdits[key];
          }
        }
        const nextActiveId =
          prev.activeItemId === id ? (nextQueue[0]?.id ?? null) : prev.activeItemId;
        return {
          ...prev,
          queue: nextQueue,
          resultsByItemId: nextResults,
          editedTexts: nextEdits,
          activeItemId: nextActiveId,
          activePageNumber: 1,
          selectedLineIndex: null,
        };
      });
    },
    [updateExtractTextSession],
  );

  const handleClearAll = useCallback(() => {
    if (stateRef.current.taskStatus === "running") return;
    updateExtractTextSession((prev) => ({
      ...prev,
      queue: [],
      resultsByItemId: {},
      editedTexts: {},
      activeItemId: null,
      activePageNumber: 1,
      selectedLineIndex: null,
      lastCancelled: false,
      errorMessage: null,
    }));
  }, [updateExtractTextSession]);

  const activeEntry = useMemo(
    () => state.queue.find((q) => q.id === state.activeItemId) ?? state.queue[0] ?? null,
    [state.activeItemId, state.queue],
  );

  const activeResult: OcrBatchItemResult | null = activeEntry
    ? (state.resultsByItemId[activeEntry.id] ?? null)
    : null;

  const activePage: OcrPageResult | null = useMemo(() => {
    if (!activeResult || activeResult.pages.length === 0) return null;
    return (
      activeResult.pages.find((p) => p.pageNumber === state.activePageNumber) ??
      activeResult.pages[0] ??
      null
    );
  }, [activeResult, state.activePageNumber]);

  const activeEditKey =
    activeEntry && activePage ? makeEditKey(activeEntry.id, activePage.pageNumber) : "";
  const activeText =
    activeEntry && activePage ? (state.editedTexts[activeEditKey] ?? activePage.text) : "";

  const combinedAllText = useMemo(() => {
    const sections: string[] = [];
    for (const q of state.queue) {
      const res = state.resultsByItemId[q.id];
      if (!res || res.pages.length === 0) continue;
      const pageBlocks = res.pages.map((p) => {
        const text = state.editedTexts[makeEditKey(q.id, p.pageNumber)] ?? p.text;
        return res.pages.length > 1
          ? `--- ${q.fileName} (Page ${p.pageNumber}) ---\n${text}`
          : text;
      });
      if (state.queue.length > 1 && res.pages.length === 1) {
        sections.push(`=== ${q.fileName} ===\n${pageBlocks[0]}`);
      } else {
        sections.push(pageBlocks.join("\n\n"));
      }
    }
    return sections.join("\n\n");
  }, [state.editedTexts, state.queue, state.resultsByItemId]);

  const handleCopyText = useCallback(
    async (text: string, label: string) => {
      if (!text) return;
      try {
        await writeSystemClipboardText(text);
        showToast(setCopyFeedback, label);
      } catch (err) {
        updateExtractTextSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [showToast, t, updateExtractTextSession],
  );

  const forbiddenSourcePaths = useMemo(() => {
    const seen = new Set<string>();
    const paths: string[] = [];
    for (const q of state.queue) {
      const p = q.path?.trim();
      if (!p) continue;
      const key = p.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        paths.push(p);
      }
    }
    return paths;
  }, [state.queue]);

  const handleExportTxt = useCallback(async () => {
    const content = combinedAllText || activeText;
    if (!content) return;
    const baseName = activeEntry ? activeEntry.fileName.replace(/\.[^.]+$/, "") : "winkit-ocr";
    const outPath = await pickSaveFilePath({
      title: zh ? "导出识别文本 (.txt)" : "Export Extracted Text (.txt)",
      defaultPath: `${baseName}_ocr.txt`,
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!outPath) return;
    try {
      await saveLocalTextFile({
        outputPath: outPath,
        sourcePath: activeEntry?.path ?? null,
        forbiddenSourcePaths,
        content,
        overwrite: true,
        toolId: "T03",
      });
      showToast(setSaveNotice, zh ? "已导出 .txt" : "Exported .txt");
    } catch (err) {
      updateExtractTextSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  }, [
    activeEntry,
    activeText,
    combinedAllText,
    forbiddenSourcePaths,
    showToast,
    t,
    updateExtractTextSession,
    zh,
  ]);

  const handleExportJson = useCallback(async () => {
    const items = state.queue
      .map((q) => state.resultsByItemId[q.id])
      .filter((r): r is OcrBatchItemResult => Boolean(r && r.pages.length > 0));
    if (items.length === 0) return;
    const baseName = activeEntry ? activeEntry.fileName.replace(/\.[^.]+$/, "") : "winkit-ocr";
    const outPath = await pickSaveFilePath({
      title: zh ? "导出结构化 OCR 坐标 JSON" : "Export Structured OCR JSON",
      defaultPath: `${baseName}_ocr_boxes.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!outPath) return;
    try {
      const sanitizedItems = items.map((item) => {
        const pages = item.pages.map((p) => {
          const edited = state.editedTexts[makeEditKey(item.sourceId, p.pageNumber)];
          const base = Object.fromEntries(
            Object.entries(p).filter(([k]) => k !== "previewDataUrl"),
          );
          if (edited !== undefined && edited !== p.text) {
            return { ...base, text: edited, rawText: p.text };
          }
          return base;
        });
        const combinedText =
          pages.length <= 1
            ? String(pages[0]?.text ?? item.combinedText)
            : pages
                .map((p) => `--- Page ${String(p.pageNumber)} ---\n${String(p.text ?? "")}`)
                .join("\n\n");
        return {
          ...item,
          combinedText,
          pages,
        };
      });
      const payload = {
        schema: "winkit.ocr.v1",
        engine: state.engineStatus?.engineName ?? "RapidOCR PP-OCRv4 mobile (ONNX Runtime CPU)",
        items: sanitizedItems,
      };
      await saveLocalTextFile({
        outputPath: outPath,
        sourcePath: activeEntry?.path ?? null,
        forbiddenSourcePaths,
        content: JSON.stringify(payload, null, 2),
        overwrite: true,
        toolId: "T03",
      });
      showToast(setSaveNotice, zh ? "已导出坐标 JSON" : "Exported JSON");
    } catch (err) {
      updateExtractTextSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  }, [
    activeEntry,
    forbiddenSourcePaths,
    showToast,
    state.editedTexts,
    state.engineStatus,
    state.queue,
    state.resultsByItemId,
    t,
    updateExtractTextSession,
    zh,
  ]);

  const previewUrl = activePage?.previewDataUrl ?? activeEntry?.thumbnailDataUrl ?? null;
  const isRunning = state.taskStatus === "running";
  const pendingRunnableCount = useMemo(
    () =>
      state.queue.filter(
        (q) => !q.inspectError && state.resultsByItemId[q.id]?.status !== "completed",
      ).length,
    [state.queue, state.resultsByItemId],
  );
  const canRerunActive = Boolean(
    !isRunning &&
    activeEntry &&
    !activeEntry.inspectError &&
    activeResult &&
    state.engineStatus?.ready !== false,
  );
  const hasAnyResult = Object.values(state.resultsByItemId).some((r) => r.pages.length > 0);
  const activePageIdx = activeResult
    ? activeResult.pages.findIndex((p) => p.pageNumber === activePage?.pageNumber)
    : -1;

  return (
    <div className="ocr-workspace">
      <div className="ocr-toolbar">
        <div className="ocr-toolbar-group">
          <button
            type="button"
            className="btn"
            disabled={isRunning || inspectBusy}
            onClick={() => void handleOpenFiles()}
          >
            <FilePlus2 size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{zh ? "选择图片 / PDF..." : "Open Images / PDF..."}</span>
          </button>
          <button
            type="button"
            className="btn"
            disabled={isRunning}
            onClick={() => void handlePasteClipboard()}
            title="Ctrl+V"
          >
            <ClipboardPaste size={15} strokeWidth={1.75} aria-hidden="true" />
            <span>{zh ? "粘贴剪贴板图片" : "Paste Image"}</span>
          </button>
          {!isRunning ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={pendingRunnableCount === 0 || state.engineStatus?.ready === false}
                title={
                  pendingRunnableCount === 0 && hasAnyResult
                    ? zh
                      ? "队列中已全部识别；如需覆盖手工校对内容请点击「重新识别当前项」"
                      : "All queued items are recognized; click Re-run Current to explicitly overwrite manual edits"
                    : undefined
                }
                onClick={() => void handleRunOcr("pending")}
              >
                <Play size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>
                  {hasAnyResult && pendingRunnableCount > 0
                    ? zh
                      ? `开始离线识别 (${pendingRunnableCount} 待处理)`
                      : `Extract Text (${pendingRunnableCount} pending)`
                    : zh
                      ? "开始离线识别"
                      : "Extract Text"}
                </span>
              </button>
              {canRerunActive && (
                <button
                  type="button"
                  className="btn"
                  title={
                    zh
                      ? "仅重新识别当前选中文件，并覆盖当前文件的手工校对文本"
                      : "Explicitly re-run OCR on the active item and replace its manual edits"
                  }
                  onClick={() => void handleRunOcr("rerun-active")}
                >
                  <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{zh ? "重新识别当前项" : "Re-run Current"}</span>
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn btn-danger" onClick={() => void handleCancelOcr()}>
              <Square size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{zh ? "取消识别" : "Cancel"}</span>
            </button>
          )}
        </div>

        <div className="ocr-toolbar-group">
          <label className="ocr-inline-field">
            <span>{zh ? "PDF 渲染" : "PDF DPI"}</span>
            <select
              className="ocr-select"
              value={state.pdfDpi}
              disabled={isRunning}
              onChange={(e) =>
                updateExtractTextSession((prev) => ({
                  ...prev,
                  pdfDpi: Number(e.target.value) as 150 | 200 | 250,
                }))
              }
            >
              <option value={150}>150 DPI</option>
              <option value={200}>200 DPI</option>
              <option value={250}>250 DPI</option>
            </select>
          </label>
          <label className="ocr-inline-field">
            <span>{zh ? "检测边长" : "Det Max"}</span>
            <select
              className="ocr-select"
              value={state.maxSideLen}
              disabled={isRunning}
              onChange={(e) =>
                updateExtractTextSession((prev) => ({
                  ...prev,
                  maxSideLen: Number(e.target.value) as 960 | 1280 | 1600,
                }))
              }
            >
              <option value={960}>{zh ? "960 px（快速）" : "960 px (Fast)"}</option>
              <option value={1280}>{zh ? "1280 px（均衡）" : "1280 px (Balanced)"}</option>
              <option value={1600}>{zh ? "1600 px（密文扫描）" : "1600 px (Dense Scan)"}</option>
            </select>
          </label>
          {state.queue.length > 0 && (
            <button type="button" className="btn" disabled={isRunning} onClick={handleClearAll}>
              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{zh ? "清空" : "Clear"}</span>
            </button>
          )}
        </div>

        <div className="ocr-toolbar-spacer" />

        <span
          className={`ocr-engine-pill ${
            state.engineStatus?.ready === false ? "error" : state.engineStatus?.ready ? "ready" : ""
          }`}
          title={state.engineStatus?.engineName ?? ""}
        >
          <ScanText size={13} strokeWidth={1.75} aria-hidden="true" />
          <span>
            {state.engineStatus?.ready === false
              ? zh
                ? "离线 OCR 引擎缺失"
                : "OCR Runtime Missing"
              : zh
                ? "RapidOCR PP-OCRv4 · 本地离线"
                : "RapidOCR PP-OCRv4 · Offline"}
          </span>
        </span>
      </div>

      {state.engineStatus?.ready === false && state.engineStatus.error && (
        <div className="ocr-banner error" role="alert">
          <span>{state.engineStatus.error}</span>
        </div>
      )}

      {state.errorMessage && (
        <div className="ocr-banner error" role="alert">
          <span>{state.errorMessage}</span>
        </div>
      )}

      {state.lastCancelled && !isRunning && (
        <div className="ocr-banner info" role="status">
          <span>
            {zh
              ? "已按请求取消识别；已完成页面的文字与坐标已保留在当前会话中。"
              : "OCR cancelled as requested; results from already completed pages are preserved in this session."}
          </span>
        </div>
      )}

      {isRunning && state.progress && (
        <div className="ocr-progress-bar-wrap" role="status" aria-live="polite">
          <div className="ocr-progress-head">
            <span>
              {zh
                ? `正在离线识别 (${state.progress.currentItem}/${state.progress.totalItems})：${state.progress.label}`
                : `Running offline OCR (${state.progress.currentItem}/${state.progress.totalItems}): ${state.progress.label}`}
            </span>
            <span>{Math.round(state.progress.percent)}%</span>
          </div>
          <div className="ocr-progress-track">
            <div
              className="ocr-progress-fill"
              style={{ width: `${Math.min(100, Math.max(4, state.progress.percent))}%` }}
            />
          </div>
        </div>
      )}

      {state.queue.length > 0 && (
        <div className="ocr-queue-strip" aria-label={zh ? "待识别队列" : "OCR Source Queue"}>
          {state.queue.map((item) => {
            const res = state.resultsByItemId[item.id];
            const isActive = activeEntry?.id === item.id;
            return (
              <div
                key={item.id}
                className={`ocr-queue-chip ${isActive ? "active" : ""}`}
                onClick={() =>
                  updateExtractTextSession((prev) => ({
                    ...prev,
                    activeItemId: item.id,
                    activePageNumber: res?.pages[0]?.pageNumber ?? 1,
                    selectedLineIndex: null,
                  }))
                }
              >
                {item.thumbnailDataUrl ? (
                  <img src={item.thumbnailDataUrl} alt="" className="ocr-queue-thumb" />
                ) : (
                  <FileText size={20} strokeWidth={1.75} aria-hidden="true" />
                )}
                <div className="ocr-queue-meta">
                  <span className="ocr-queue-name" title={item.fileName}>
                    {item.fileName}
                  </span>
                  <span className="ocr-queue-sub">
                    {item.inspectError
                      ? item.inspectError
                      : res
                        ? res.status === "failed"
                          ? (res.errorMessage ?? (zh ? "失败" : "Failed"))
                          : zh
                            ? `${res.pages.length} 页 · ${res.totalLines} 行 · ${res.elapsedMs} ms`
                            : `${res.pages.length}p · ${res.totalLines} lines · ${res.elapsedMs} ms`
                        : item.kind === "pdf"
                          ? zh
                            ? `PDF · ${item.pageCount} 页${item.isLikelyScanned ? " · 扫描件" : ""}`
                            : `PDF · ${item.pageCount}p${item.isLikelyScanned ? " · Scanned" : ""}`
                          : item.widthPx && item.heightPx
                            ? `${item.widthPx}×${item.heightPx}${item.byteLength > 0 ? ` · ${formatByteSize(item.byteLength)}` : ""}`
                            : formatByteSize(item.byteLength)}
                  </span>
                </div>
                {item.kind === "pdf" && !item.inspectError && (
                  <input
                    type="text"
                    className="ocr-range-input"
                    value={item.pageRange}
                    disabled={isRunning}
                    placeholder={zh ? `1-${item.pageCount}` : `1-${item.pageCount}`}
                    aria-label={zh ? `${item.fileName} 页码范围` : `${item.fileName} page range`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                      const val = e.target.value;
                      updateExtractTextSession((prev) => ({
                        ...prev,
                        queue: prev.queue.map((q) =>
                          q.id === item.id ? { ...q, pageRange: val } : q,
                        ),
                      }));
                    }}
                  />
                )}
                <button
                  type="button"
                  className="ocr-icon-btn"
                  disabled={isRunning}
                  aria-label={zh ? `移除 ${item.fileName}` : `Remove ${item.fileName}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleRemoveItem(item.id);
                  }}
                >
                  <X size={14} strokeWidth={1.75} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="ocr-main-grid">
        {/* Left: Visual Preview + Interactive Bounding Boxes */}
        <section className="ocr-panel" aria-label={zh ? "原图与识别框预览" : "Source Preview"}>
          <div className="ocr-panel-header">
            <span>
              {activeEntry
                ? activeEntry.fileName
                : zh
                  ? "图片 / 扫描件预览"
                  : "Image / Scan Preview"}
            </span>
            <div className="ocr-panel-actions">
              {activeResult && activeResult.pages.length > 1 && activePage && (
                <div className="ocr-page-nav">
                  <button
                    type="button"
                    className="ocr-icon-btn"
                    disabled={activePageIdx <= 0}
                    aria-label={zh ? "上一页" : "Previous page"}
                    onClick={() => {
                      const prevPage = activeResult.pages[activePageIdx - 1];
                      if (prevPage) {
                        updateExtractTextSession((prev) => ({
                          ...prev,
                          activePageNumber: prevPage.pageNumber,
                          selectedLineIndex: null,
                        }));
                      }
                    }}
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span>
                    {zh
                      ? `第 ${activePage.pageNumber} 页 (${activePageIdx + 1}/${activeResult.pages.length})`
                      : `P${activePage.pageNumber} (${activePageIdx + 1}/${activeResult.pages.length})`}
                  </span>
                  <button
                    type="button"
                    className="ocr-icon-btn"
                    disabled={activePageIdx < 0 || activePageIdx + 1 >= activeResult.pages.length}
                    aria-label={zh ? "下一页" : "Next page"}
                    onClick={() => {
                      const nextPage = activeResult.pages[activePageIdx + 1];
                      if (nextPage) {
                        updateExtractTextSession((prev) => ({
                          ...prev,
                          activePageNumber: nextPage.pageNumber,
                          selectedLineIndex: null,
                        }));
                      }
                    }}
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
              {activePage && activePage.lines.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    updateExtractTextSession((prev) => ({ ...prev, showBoxes: !prev.showBoxes }))
                  }
                >
                  {state.showBoxes ? <EyeOff size={14} /> : <Eye size={14} />}
                  <span>
                    {state.showBoxes
                      ? zh
                        ? "隐藏识别框"
                        : "Hide Boxes"
                      : zh
                        ? "显示识别框"
                        : "Show Boxes"}
                  </span>
                </button>
              )}
            </div>
          </div>

          <div className="ocr-preview-stage">
            {previewUrl ? (
              <div className="ocr-canvas-frame">
                <img
                  src={previewUrl}
                  alt={activeEntry?.fileName ?? "OCR preview"}
                  className="ocr-preview-img"
                />
                {state.showBoxes && activePage && activePage.lines.length > 0 && (
                  <svg
                    className="ocr-overlay-svg"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-label={zh ? "识别文字位置框" : "Recognized text regions"}
                  >
                    {activePage.lines.map((line: OcrTextLine) => {
                      const points = line.quadNorm
                        .map((pt) => `${(pt.x * 100).toFixed(2)},${(pt.y * 100).toFixed(2)}`)
                        .join(" ");
                      const isSel = state.selectedLineIndex === line.index;
                      return (
                        <polygon
                          key={line.index}
                          points={points}
                          className={`ocr-overlay-poly ${isSel ? "selected" : ""}`}
                          onClick={() =>
                            updateExtractTextSession((prev) => ({
                              ...prev,
                              selectedLineIndex:
                                prev.selectedLineIndex === line.index ? null : line.index,
                            }))
                          }
                        >
                          <title>{`${line.text} (${Math.round(line.confidence * 100)}%)`}</title>
                        </polygon>
                      );
                    })}
                  </svg>
                )}
              </div>
            ) : (
              <div className="ocr-dropzone-empty">
                <ScanText size={32} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  {zh
                    ? "拖入截图、照片或扫描版 PDF，或按 Ctrl+V 粘贴剪贴板图片"
                    : "Drop screenshots, photos, or scanned PDFs here, or press Ctrl+V to paste an image"}
                </div>
                <div style={{ fontSize: 12 }}>
                  {zh
                    ? "全部识别均在隔离本地子进程中离线完成，自动输出供 T04/P04 复用的文字与坐标"
                    : "Runs 100% offline in an isolated local worker and outputs text + coordinates reusable by T04/P04"}
                </div>
              </div>
            )}
          </div>

          {activePage && (
            <div className="ocr-footer-bar">
              <span>
                {activePage.imageWidthPx}×{activePage.imageHeightPx} px
                {activePage.renderDpi ? ` · ${activePage.renderDpi} DPI` : ""}
              </span>
              <span>
                {zh
                  ? `${activePage.lineCount} 行 · 平均置信度 ${(activePage.averageConfidence * 100).toFixed(1)}% · ${activePage.elapsedMs} ms`
                  : `${activePage.lineCount} lines · Avg conf ${(activePage.averageConfidence * 100).toFixed(1)}% · ${activePage.elapsedMs} ms`}
              </span>
            </div>
          )}
        </section>

        {/* Right: Extracted Text & Structured Lines/Coordinates */}
        <section className="ocr-panel" aria-label={zh ? "识别结果" : "Extracted Result"}>
          <div className="ocr-panel-header">
            <div className="ocr-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={state.rightTab === "text"}
                className={`ocr-tab-btn ${state.rightTab === "text" ? "active" : ""}`}
                onClick={() => updateExtractTextSession((prev) => ({ ...prev, rightTab: "text" }))}
              >
                {zh ? "识别文本" : "Extracted Text"}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={state.rightTab === "boxes"}
                className={`ocr-tab-btn ${state.rightTab === "boxes" ? "active" : ""}`}
                onClick={() => updateExtractTextSession((prev) => ({ ...prev, rightTab: "boxes" }))}
              >
                {zh
                  ? `逐行坐标 (${activePage?.lineCount ?? 0})`
                  : `Lines & Boxes (${activePage?.lineCount ?? 0})`}
              </button>
            </div>

            <div className="ocr-panel-actions">
              <button
                type="button"
                className="btn"
                disabled={!activeText}
                onClick={() => void handleCopyText(activeText, zh ? "已复制当前页" : "Copied page")}
              >
                {copyFeedback ? <Check size={14} /> : <Copy size={14} />}
                <span>{copyFeedback ?? (zh ? "复制当前页" : "Copy Page")}</span>
              </button>
              {hasAnyResult &&
                (state.queue.length > 1 || (activeResult && activeResult.pages.length > 1)) && (
                  <button
                    type="button"
                    className="btn"
                    disabled={!combinedAllText}
                    onClick={() =>
                      void handleCopyText(combinedAllText, zh ? "已复制全部结果" : "Copied all")
                    }
                  >
                    <Copy size={14} />
                    <span>{zh ? "复制全部" : "Copy All"}</span>
                  </button>
                )}
              <button
                type="button"
                className="btn"
                disabled={!combinedAllText && !activeText}
                onClick={() => void handleExportTxt()}
              >
                <Download size={14} />
                <span>.txt</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!hasAnyResult}
                onClick={() => void handleExportJson()}
                title={
                  zh
                    ? "导出含像素与归一化坐标的结构化 JSON"
                    : "Export structured JSON with coordinates"
                }
              >
                <FileCode2 size={14} />
                <span>JSON</span>
              </button>
            </div>
          </div>

          {state.rightTab === "text" ? (
            <textarea
              className="ocr-textarea"
              value={activeText}
              aria-label={zh ? "离线识别文本结果" : "Offline OCR extracted text"}
              placeholder={
                zh
                  ? "载入图片或扫描版 PDF 后点击「开始离线识别」，结果会显示在这里（支持直接校对、复制或导出 .txt）..."
                  : "Add an image or scanned PDF and click Extract Text to view, edit, copy, or export results..."
              }
              onChange={(e) => {
                if (!activeEditKey) return;
                const val = e.target.value;
                updateExtractTextSession((prev) => ({
                  ...prev,
                  editedTexts: { ...prev.editedTexts, [activeEditKey]: val },
                }));
              }}
            />
          ) : (
            <div className="ocr-lines-list">
              {!activePage || activePage.lines.length === 0 ? (
                <div style={{ padding: 20, color: "var(--text-secondary)", fontSize: 13 }}>
                  {zh
                    ? "当前页暂无识别行。完成识别后可查看每一行的文本、置信度、像素坐标与词级 Span（供 T04/P04 直接复用）。"
                    : "No recognized lines on this page yet. Run OCR to inspect text, confidence, pixel/normalized boxes, and token spans (reusable by T04/P04)."}
                </div>
              ) : (
                activePage.lines.map((line) => {
                  const isSel = state.selectedLineIndex === line.index;
                  return (
                    <div
                      key={line.index}
                      className={`ocr-line-row ${isSel ? "selected" : ""}`}
                      onClick={() =>
                        updateExtractTextSession((prev) => ({
                          ...prev,
                          selectedLineIndex:
                            prev.selectedLineIndex === line.index ? null : line.index,
                        }))
                      }
                    >
                      <div className="ocr-line-top">
                        <span className="ocr-line-text">{line.text}</span>
                        <button
                          type="button"
                          className="ocr-icon-btn"
                          title={zh ? "复制此行" : "Copy line"}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleCopyText(line.text, zh ? "已复制该行" : "Copied line");
                          }}
                        >
                          <Copy size={13} />
                        </button>
                      </div>
                      <div className="ocr-line-coords">
                        #{line.index + 1} · row {line.rowIndex} ·{" "}
                        {(line.confidence * 100).toFixed(1)}% · px(
                        {Math.round(line.bboxPx.x)},{Math.round(line.bboxPx.y)}{" "}
                        {Math.round(line.bboxPx.width)}×{Math.round(line.bboxPx.height)}) · norm(
                        {line.bboxNorm.x.toFixed(3)},{line.bboxNorm.y.toFixed(3)}{" "}
                        {line.bboxNorm.width.toFixed(3)}×{line.bboxNorm.height.toFixed(3)}) ·{" "}
                        {line.spans.length} spans
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}

          <div className="ocr-footer-bar">
            <span>
              {saveNotice
                ? saveNotice
                : zh
                  ? "识别结果仅保存在当前会话内存，绝不自动写入磁盘或上传云端"
                  : "OCR results stay in memory only and are never persisted or uploaded"}
            </span>
            {activePage && (
              <span>{zh ? `${activeText.length} 字符` : `${activeText.length} chars`}</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
