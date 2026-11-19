import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  Eraser,
  FolderOpen,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { isFrontendShuttingDown } from "../../lib/shutdownGate";
import {
  bindDisposableListener,
  cancelBackendTask,
  computeBatchFileHashes,
  computeTextHashes,
  formatLocalizedError,
  parseBackendError,
  pickMultipleFiles,
  pickSaveFilePath,
  saveLocalTextFile,
  subscribeFileDrop,
  subscribeHashBatchItemProgress,
  suggestSafeSiblingPath,
  writeSystemClipboardText,
  type BatchHashInputItem,
} from "../../lib/tauriBridge";
import {
  ALL_HASH_ALGORITHMS,
  areAlgorithmListsEqual,
  buildHashBatchCsvBounded,
  compareMultiDigests,
  formatBatchCopyAllText,
  formatByteSize,
  formatDigestHex,
  HASH_BATCH_PAGE_SIZE,
  isLegacyCompatAlgorithm,
  MAX_HASH_BATCH_FILES,
  utf8ByteLength,
  type ExpectedCompareStatus,
  type HashAlgorithm,
  type HashBatchFileItem,
  type HashBatchState,
} from "./hashUtils";

let hashBatchGenSeq = 1;
let hashAttemptSeq = 1;
let hashItemIdSeq = 1;

type BatchFilterMode = "all" | "incomplete" | "error" | "completed";

interface SaveHashCsvSnapshot {
  signature: string;
  csvText: string;
  forbiddenSourcePaths: string[];
  firstSourcePath: string | null;
}

function normalizeWinPathForExactDedup(rawPath: string): string {
  return rawPath.trim().replace(/\//g, "\\").toLowerCase();
}

function extractFileNameFromPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  const parts = trimmed.split(/[\\/]/);
  const last = parts[parts.length - 1];
  return last && last.length > 0 ? last : trimmed;
}

function extractParentDirHint(rawPath: string): string {
  const trimmed = rawPath.trim();
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx > 0 ? trimmed.slice(0, idx) : trimmed;
}

function computeBatchExportSignature(
  batch: HashBatchState | null,
  uppercase: boolean,
  formulaProtection: boolean,
): string {
  if (!batch) return "empty";
  const rowsSig = batch.items
    .map(
      (it) =>
        `${it.itemId}:${it.status}:${it.byteLength ?? "n"}:${it.expectedHash}:${it.errorCode ?? ""}`,
    )
    .join("|");
  return `${batch.batchGeneration}#${batch.algorithmsSnapshot.join(",")}#u=${uppercase ? 1 : 0}#f=${formulaProtection ? 1 : 0}#${rowsSig}`;
}

export function HashGeneratorWorkspace() {
  const { t } = useI18n();
  const { session, updateHashSession } = useSessionStore();
  const {
    mode,
    selectedAlgorithms,
    uppercase,
    textInput,
    textDigests,
    textStatus,
    textErrorMessage,
    textExpectedHash,
    batch,
    csvFormulaProtection,
  } = session.hash;

  const compareInputId = useId();
  const textInputId = useId();

  const mountedRef = useRef(true);
  const batchGenRef = useRef<number>(batch?.batchGeneration ?? 0);
  const activeAttemptIdRef = useRef<string | null>(batch?.activeAttemptId ?? null);
  const textReqSeqRef = useRef(0);

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [dropHover, setDropHover] = useState(false);
  const [batchFilter, setBatchFilter] = useState<BatchFilterMode>("all");
  const [pageIndex, setPageIndex] = useState(0);
  const [ioBanner, setIoBanner] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(
    null,
  );
  const [pendingOverwrite, setPendingOverwrite] = useState<{
    targetPath: string;
    snapshot: SaveHashCsvSnapshot;
  } | null>(null);

  // Keep refs synchronized with session state
  batchGenRef.current = batch?.batchGeneration ?? 0;
  activeAttemptIdRef.current = batch?.activeAttemptId ?? null;

  const latestSignatureRef = useRef("");
  latestSignatureRef.current = computeBatchExportSignature(batch, uppercase, csvFormulaProtection);

  const updateHashSessionRef = useRef(updateHashSession);
  updateHashSessionRef.current = updateHashSession;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const inFlight = activeAttemptIdRef.current;
      if (inFlight) {
        activeAttemptIdRef.current = null;
        void cancelBackendTask(inFlight);
        updateHashSessionRef.current((prev) => {
          if (!prev.batch || prev.batch.activeAttemptId !== inFlight) {
            return prev;
          }
          return {
            ...prev,
            batch: {
              ...prev.batch,
              activeAttemptId: null,
              items: prev.batch.items.map((item) =>
                item.status === "running" || item.status === "pending"
                  ? { ...item, status: "cancelled", progressPercent: null }
                  : item,
              ),
            },
          };
        });
      }
    };
  }, []);

  // Subscribe to streaming per-item batch events from Rust
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeHashBatchItemProgress((payload) => {
          if (!mountedRef.current || isFrontendShuttingDown()) return;
          if (!activeAttemptIdRef.current || payload.batchId !== activeAttemptIdRef.current) {
            return;
          }
          const localizedErr =
            payload.state === "error" && payload.errorCode
              ? formatLocalizedError(
                  { code: payload.errorCode, message: payload.errorMessage ?? "" },
                  t,
                )
              : payload.errorMessage;

          updateHashSession((prev) => {
            if (!prev.batch || prev.batch.activeAttemptId !== payload.batchId) {
              return prev;
            }
            return {
              ...prev,
              batch: {
                ...prev.batch,
                items: prev.batch.items.map((it) => {
                  if (it.itemId !== payload.itemId) return it;
                  if (payload.state === "running") {
                    return {
                      ...it,
                      status: "running",
                      processedBytes: payload.processedBytes,
                      byteLength: payload.byteLength ?? it.byteLength,
                      progressPercent: payload.percent,
                    };
                  }
                  if (payload.state === "completed") {
                    return {
                      ...it,
                      status: "completed",
                      processedBytes: payload.processedBytes,
                      byteLength: payload.byteLength ?? it.byteLength,
                      progressPercent: 100,
                      digests: payload.digests,
                      errorCode: null,
                      errorMessage: null,
                    };
                  }
                  if (payload.state === "cancelled") {
                    return {
                      ...it,
                      status: "cancelled",
                      processedBytes: payload.processedBytes,
                      progressPercent: null,
                      digests: null,
                      errorCode: payload.errorCode,
                      errorMessage: null,
                    };
                  }
                  return {
                    ...it,
                    status: "error",
                    processedBytes: payload.processedBytes,
                    progressPercent: null,
                    digests: null,
                    errorCode: payload.errorCode,
                    errorMessage: localizedErr ?? payload.errorMessage,
                  };
                }),
              },
            };
          });
        }),
      "d03-hash-batch-item",
    );
  }, [t, updateHashSession]);

  const runBatchAttempt = useCallback(
    async (
      targetGen: number,
      attemptId: string,
      inputs: readonly BatchHashInputItem[],
      algsSnapshot: readonly HashAlgorithm[],
    ) => {
      try {
        const res = await computeBatchFileHashes(attemptId, inputs, algsSnapshot);
        if (
          !mountedRef.current ||
          isFrontendShuttingDown() ||
          batchGenRef.current !== targetGen ||
          activeAttemptIdRef.current !== attemptId
        ) {
          return;
        }
        activeAttemptIdRef.current = null;
        const resultMap = new Map(res.items.map((r) => [r.itemId, r]));

        updateHashSession((prev) => {
          if (
            !prev.batch ||
            prev.batch.batchGeneration !== targetGen ||
            prev.batch.activeAttemptId !== attemptId
          ) {
            return prev;
          }
          return {
            ...prev,
            batch: {
              ...prev.batch,
              activeAttemptId: null,
              items: prev.batch.items.map((it) => {
                const outcome = resultMap.get(it.itemId);
                if (!outcome) return it;
                if (outcome.status === "completed") {
                  return {
                    ...it,
                    fileName: outcome.fileName || it.fileName,
                    path: outcome.path || it.path,
                    status: "completed",
                    byteLength: outcome.byteLength,
                    processedBytes: outcome.byteLength ?? 0,
                    progressPercent: 100,
                    digests: outcome.digests,
                    errorCode: null,
                    errorMessage: null,
                  };
                }
                if (outcome.status === "cancelled") {
                  return {
                    ...it,
                    status: "cancelled",
                    progressPercent: null,
                    digests: null,
                    errorCode: "TASK_CANCELLED",
                    errorMessage: null,
                  };
                }
                const localized = outcome.errorCode
                  ? formatLocalizedError(
                      { code: outcome.errorCode, message: outcome.errorMessage ?? "" },
                      t,
                    )
                  : (outcome.errorMessage ?? t.errors.FALLBACK);
                return {
                  ...it,
                  status: "error",
                  byteLength: outcome.byteLength ?? it.byteLength,
                  progressPercent: null,
                  digests: null,
                  errorCode: outcome.errorCode ?? "FALLBACK",
                  errorMessage: localized,
                };
              }),
            },
          };
        });
      } catch (err) {
        if (
          !mountedRef.current ||
          isFrontendShuttingDown() ||
          batchGenRef.current !== targetGen ||
          activeAttemptIdRef.current !== attemptId
        ) {
          return;
        }
        activeAttemptIdRef.current = null;
        const parsed = parseBackendError(err);
        const isCancelled = parsed.code === "TASK_CANCELLED";
        const localized = isCancelled ? null : formatLocalizedError(err, t);
        const attemptedIds = new Set(inputs.map((i) => i.itemId));

        updateHashSession((prev) => {
          if (
            !prev.batch ||
            prev.batch.batchGeneration !== targetGen ||
            prev.batch.activeAttemptId !== attemptId
          ) {
            return prev;
          }
          return {
            ...prev,
            batch: {
              ...prev.batch,
              activeAttemptId: null,
              items: prev.batch.items.map((it) => {
                if (!attemptedIds.has(it.itemId) || it.status === "completed") {
                  return it;
                }
                return {
                  ...it,
                  status: isCancelled ? "cancelled" : "error",
                  progressPercent: null,
                  digests: null,
                  errorCode: parsed.code,
                  errorMessage: localized,
                };
              }),
            },
          };
        });
      }
    },
    [t, updateHashSession],
  );

  const startFreshFileBatch = useCallback(
    (rawPaths: readonly string[], algsToFreeze: readonly HashAlgorithm[]) => {
      if (isFrontendShuttingDown() || rawPaths.length === 0) return;

      // Deduplicate ONLY identical normalized full paths; preserve same-basename files in different folders
      const seenPaths = new Set<string>();
      const uniquePaths: string[] = [];
      for (const p of rawPaths) {
        const trimmed = p.trim();
        if (!trimmed) continue;
        const key = normalizeWinPathForExactDedup(trimmed);
        if (!seenPaths.has(key)) {
          seenPaths.add(key);
          uniquePaths.push(trimmed);
        }
      }
      if (uniquePaths.length === 0) return;

      if (activeAttemptIdRef.current) {
        void cancelBackendTask(activeAttemptIdRef.current);
      }

      const acceptedPaths = uniquePaths.slice(0, MAX_HASH_BATCH_FILES);
      const overflowSkippedCount = Math.max(0, uniquePaths.length - acceptedPaths.length);

      const nextGen = ++hashBatchGenSeq;
      const attemptId = `d03-batch-${nextGen}-${++hashAttemptSeq}`;
      batchGenRef.current = nextGen;
      activeAttemptIdRef.current = attemptId;

      const algsSnapshot = ALL_HASH_ALGORITHMS.filter((a) => algsToFreeze.includes(a));
      const newItems: HashBatchFileItem[] = acceptedPaths.map((p) => ({
        itemId: `d03-item-${++hashItemIdSeq}`,
        path: p,
        fileName: extractFileNameFromPath(p),
        byteLength: null,
        status: "pending",
        processedBytes: 0,
        progressPercent: null,
        digests: null,
        errorCode: null,
        errorMessage: null,
        expectedHash: "",
      }));

      setIoBanner(null);
      setPendingOverwrite(null);
      setCopiedKey(null);
      setBatchFilter("all");
      setPageIndex(0);

      updateHashSession({
        mode: "file",
        batch: {
          batchGeneration: nextGen,
          activeAttemptId: attemptId,
          algorithmsSnapshot: algsSnapshot,
          items: newItems,
          selectedItemId: newItems[0]?.itemId ?? null,
          overflowSkippedCount,
        },
      });

      const batchInputs: BatchHashInputItem[] = newItems.map((it) => ({
        itemId: it.itemId,
        path: it.path,
      }));
      void runBatchAttempt(nextGen, attemptId, batchInputs, algsSnapshot);
    },
    [runBatchAttempt, updateHashSession],
  );

  const runTextHash = useCallback(
    async (value: string, algs: readonly HashAlgorithm[]) => {
      const seq = ++textReqSeqRef.current;
      try {
        const res = await computeTextHashes(value, algs);
        if (!mountedRef.current || isFrontendShuttingDown() || seq !== textReqSeqRef.current) {
          return;
        }
        updateHashSession({
          textDigests: res.digests,
          textStatus: "completed",
          textErrorMessage: null,
        });
      } catch (err) {
        if (!mountedRef.current || isFrontendShuttingDown() || seq !== textReqSeqRef.current) {
          return;
        }
        updateHashSession({
          textDigests: null,
          textStatus: "error",
          textErrorMessage: formatLocalizedError(err, t),
        });
      }
    },
    [t, updateHashSession],
  );

  // Explorer multi-file drag & drop
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (paths.length > 0) {
              startFreshFileBatch(paths, selectedAlgorithms);
            }
          },
        }),
      "hash-file-drop",
    );
  }, [selectedAlgorithms, startFreshFileBatch]);

  const isBatchRunning = Boolean(batch?.activeAttemptId);

  const batchCounts = useMemo(() => {
    const items = batch?.items ?? [];
    let completed = 0;
    let running = 0;
    let pending = 0;
    let error = 0;
    let cancelled = 0;
    for (const it of items) {
      if (it.status === "completed") completed += 1;
      else if (it.status === "running") running += 1;
      else if (it.status === "pending") pending += 1;
      else if (it.status === "error") error += 1;
      else if (it.status === "cancelled") cancelled += 1;
    }
    return {
      total: items.length,
      completed,
      running,
      pending,
      error,
      cancelled,
      incomplete: pending + cancelled,
    };
  }, [batch]);

  const batchOverallPercent = useMemo(() => {
    if (!batch || batch.items.length === 0) return 0;
    const activeItem = batch.items.find((it) => it.status === "running");
    const activeFrac =
      activeItem && activeItem.progressPercent !== null
        ? Math.max(0, Math.min(1, activeItem.progressPercent / 100))
        : 0;
    return Math.min(
      100,
      ((batchCounts.completed + activeFrac) / Math.max(1, batch.items.length)) * 100,
    );
  }, [batch, batchCounts.completed]);

  const batchNeedsAlgRecompute = useMemo(() => {
    if (!batch || batch.items.length === 0 || isBatchRunning) return false;
    return !areAlgorithmListsEqual(selectedAlgorithms, batch.algorithmsSnapshot);
  }, [batch, isBatchRunning, selectedAlgorithms]);

  const selectedBatchItem = useMemo(() => {
    if (!batch || batch.items.length === 0) return null;
    return batch.items.find((it) => it.itemId === batch.selectedItemId) ?? batch.items[0] ?? null;
  }, [batch]);

  const filteredBatchItems = useMemo(() => {
    if (!batch) return [];
    return batch.items.filter((it) => {
      if (batchFilter === "incomplete") {
        return it.status === "pending" || it.status === "cancelled" || it.status === "running";
      }
      if (batchFilter === "error") return it.status === "error";
      if (batchFilter === "completed") return it.status === "completed";
      return true;
    });
  }, [batch, batchFilter]);

  const totalPages = Math.max(1, Math.ceil(filteredBatchItems.length / HASH_BATCH_PAGE_SIZE));
  const clampedPage = Math.min(pageIndex, totalPages - 1);
  const pageStartIdx = clampedPage * HASH_BATCH_PAGE_SIZE;
  const pagedBatchItems = filteredBatchItems.slice(
    pageStartIdx,
    pageStartIdx + HASH_BATCH_PAGE_SIZE,
  );

  const liveTextBytes = useMemo(() => utf8ByteLength(textInput), [textInput]);

  // Visible digests in right pane: Text mode uses `selectedAlgorithms`; File mode uses `batch.algorithmsSnapshot`
  const visibleDigests = useMemo(() => {
    if (mode === "text") {
      if (!textDigests || textStatus !== "completed") return [];
      return textDigests
        .filter((d) => selectedAlgorithms.includes(d.algorithm))
        .map((d) => ({
          ...d,
          formatted: formatDigestHex(d.digestHex, uppercase),
        }));
    }
    if (!batch || !selectedBatchItem || selectedBatchItem.status !== "completed") {
      return [];
    }
    const itemDigests = selectedBatchItem.digests ?? [];
    return batch.algorithmsSnapshot
      .map((alg) => itemDigests.find((d) => d.algorithm === alg))
      .filter((d): d is NonNullable<typeof d> => Boolean(d))
      .map((d) => ({
        ...d,
        formatted: formatDigestHex(d.digestHex, uppercase),
      }));
  }, [batch, mode, selectedAlgorithms, selectedBatchItem, textDigests, textStatus, uppercase]);

  const activeExpectedHash =
    mode === "text" ? textExpectedHash : (selectedBatchItem?.expectedHash ?? "");

  const compareResult: ExpectedCompareStatus = useMemo(() => {
    if (mode === "text") {
      return compareMultiDigests(
        textStatus === "completed" ? textDigests : null,
        selectedAlgorithms,
        textExpectedHash,
      );
    }
    if (!batch || !selectedBatchItem) {
      return { kind: "idle" };
    }
    return compareMultiDigests(
      selectedBatchItem.status === "completed" ? selectedBatchItem.digests : null,
      batch.algorithmsSnapshot,
      selectedBatchItem.expectedHash,
    );
  }, [
    batch,
    mode,
    selectedAlgorithms,
    selectedBatchItem,
    textDigests,
    textExpectedHash,
    textStatus,
  ]);

  const handleToggleAlgorithm = (alg: HashAlgorithm) => {
    const exists = selectedAlgorithms.includes(alg);
    if (exists && selectedAlgorithms.length === 1) {
      return;
    }
    const nextAlgs = ALL_HASH_ALGORITHMS.filter((item) =>
      item === alg ? !exists : selectedAlgorithms.includes(item),
    );
    updateHashSession({ selectedAlgorithms: nextAlgs });

    if (mode === "text" && (textStatus === "completed" || textInput.length > 0)) {
      void runTextHash(textInput, nextAlgs);
    }
  };

  const handleSelectFiles = async () => {
    const chosen = await pickMultipleFiles({
      title: t.hashTool.selectFileBtn,
    });
    if (chosen.length > 0) {
      startFreshFileBatch(chosen, selectedAlgorithms);
    }
  };

  const handleCancelBatch = async () => {
    const attemptId = activeAttemptIdRef.current;
    if (!attemptId) return;
    await cancelBackendTask(attemptId);
  };

  const handleResumeIncomplete = () => {
    if (!batch || isBatchRunning || isFrontendShuttingDown()) return;
    const targets = batch.items.filter(
      (it) => it.status === "pending" || it.status === "cancelled",
    );
    if (targets.length === 0) return;

    const targetIds = new Set(targets.map((it) => it.itemId));
    const attemptId = `d03-resume-${batch.batchGeneration}-${++hashAttemptSeq}`;
    activeAttemptIdRef.current = attemptId;
    setIoBanner(null);
    setPendingOverwrite(null);

    updateHashSession((prev) => {
      if (!prev.batch || prev.batch.batchGeneration !== batch.batchGeneration) return prev;
      return {
        ...prev,
        batch: {
          ...prev.batch,
          activeAttemptId: attemptId,
          items: prev.batch.items.map((it) =>
            targetIds.has(it.itemId)
              ? {
                  ...it,
                  status: "pending",
                  processedBytes: 0,
                  progressPercent: null,
                  digests: null,
                  errorCode: null,
                  errorMessage: null,
                }
              : it,
          ),
        },
      };
    });

    void runBatchAttempt(
      batch.batchGeneration,
      attemptId,
      targets.map((it) => ({ itemId: it.itemId, path: it.path })),
      batch.algorithmsSnapshot,
    );
  };

  const handleRetryFailed = () => {
    if (!batch || isBatchRunning || isFrontendShuttingDown()) return;
    const targets = batch.items.filter((it) => it.status === "error");
    if (targets.length === 0) return;

    const targetIds = new Set(targets.map((it) => it.itemId));
    const attemptId = `d03-retry-${batch.batchGeneration}-${++hashAttemptSeq}`;
    activeAttemptIdRef.current = attemptId;
    setIoBanner(null);
    setPendingOverwrite(null);

    updateHashSession((prev) => {
      if (!prev.batch || prev.batch.batchGeneration !== batch.batchGeneration) return prev;
      return {
        ...prev,
        batch: {
          ...prev.batch,
          activeAttemptId: attemptId,
          items: prev.batch.items.map((it) =>
            targetIds.has(it.itemId)
              ? {
                  ...it,
                  status: "pending",
                  processedBytes: 0,
                  progressPercent: null,
                  digests: null,
                  errorCode: null,
                  errorMessage: null,
                }
              : it,
          ),
        },
      };
    });

    void runBatchAttempt(
      batch.batchGeneration,
      attemptId,
      targets.map((it) => ({ itemId: it.itemId, path: it.path })),
      batch.algorithmsSnapshot,
    );
  };

  const handleRecomputeBatchWithSelectedAlgs = () => {
    if (!batch || batch.items.length === 0 || isBatchRunning || isFrontendShuttingDown()) return;
    const nextGen = ++hashBatchGenSeq;
    const attemptId = `d03-recompute-${nextGen}-${++hashAttemptSeq}`;
    const algsSnapshot = ALL_HASH_ALGORITHMS.filter((a) => selectedAlgorithms.includes(a));
    batchGenRef.current = nextGen;
    activeAttemptIdRef.current = attemptId;
    setIoBanner(null);
    setPendingOverwrite(null);

    const resetItems: HashBatchFileItem[] = batch.items.map((it) => ({
      ...it,
      status: "pending",
      processedBytes: 0,
      progressPercent: null,
      digests: null,
      errorCode: null,
      errorMessage: null,
    }));

    updateHashSession({
      batch: {
        ...batch,
        batchGeneration: nextGen,
        activeAttemptId: attemptId,
        algorithmsSnapshot: algsSnapshot,
        items: resetItems,
      },
    });

    void runBatchAttempt(
      nextGen,
      attemptId,
      resetItems.map((it) => ({ itemId: it.itemId, path: it.path })),
      algsSnapshot,
    );
  };

  const handleSwitchMode = (nextMode: "text" | "file") => {
    if (nextMode === mode) return;
    setIoBanner(null);
    setCopiedKey(null);
    updateHashSession({ mode: nextMode });
    if (nextMode === "text" && textInput.length > 0 && textStatus === "idle") {
      void runTextHash(textInput, selectedAlgorithms);
    }
  };

  const copyWithFeedback = async (key: string, text: string) => {
    if (!text) return;
    try {
      await writeSystemClipboardText(text);
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setCopiedKey(key);
      window.setTimeout(() => {
        if (!mountedRef.current) return;
        setCopiedKey((prev) => (prev === key ? null : prev));
      }, 1600);
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setIoBanner({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleCopyAll = async () => {
    if (mode === "text") {
      if (visibleDigests.length === 0) return;
      const payload =
        visibleDigests.length === 1
          ? visibleDigests[0]!.formatted
          : visibleDigests.map((d) => `${d.algorithm}: ${d.formatted}`).join("\n");
      await copyWithFeedback("all", payload);
      return;
    }
    if (!batch) return;
    const payload = formatBatchCopyAllText(batch.items, batch.algorithmsSnapshot, uppercase);
    if (!payload) return;
    await copyWithFeedback("all", payload);
  };

  const executeSaveBatchCsv = async (
    targetPath: string,
    overwrite: boolean,
    snapshot: SaveHashCsvSnapshot,
  ) => {
    if (!mountedRef.current || isFrontendShuttingDown()) return;
    if (latestSignatureRef.current !== snapshot.signature) {
      setPendingOverwrite(null);
      setIoBanner({ kind: "warn", text: t.hashTool.saveAbortedChanged });
      return;
    }

    try {
      const saved = await saveLocalTextFile({
        outputPath: targetPath,
        sourcePath: snapshot.firstSourcePath,
        forbiddenSourcePaths: snapshot.forbiddenSourcePaths,
        content: snapshot.csvText,
        overwrite,
        toolId: "D03",
      });
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      setPendingOverwrite(null);
      setIoBanner({
        kind: "ok",
        text: t.hashTool.savedCsvSuccess(saved.path, saved.byteLength),
      });
    } catch (err) {
      if (!mountedRef.current || isFrontendShuttingDown()) return;
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwrite({ targetPath, snapshot });
        return;
      }
      setPendingOverwrite(null);
      setIoBanner({ kind: "err", text: formatLocalizedError(err, t) });
    }
  };

  const handleSaveBatchCsv = async () => {
    if (!batch || batch.items.length === 0 || isBatchRunning) return;
    setIoBanner(null);

    const built = buildHashBatchCsvBounded(batch.items, batch.algorithmsSnapshot, {
      uppercase,
      formulaProtection: csvFormulaProtection,
    });
    if (!built.ok) {
      setIoBanner({ kind: "err", text: built.message });
      return;
    }

    const snapshot: SaveHashCsvSnapshot = {
      signature: latestSignatureRef.current,
      csvText: built.csv,
      forbiddenSourcePaths: batch.items.map((it) => it.path),
      firstSourcePath: batch.items[0]?.path ?? null,
    };

    const defaultPath = snapshot.firstSourcePath
      ? ((await suggestSafeSiblingPath(snapshot.firstSourcePath, "_hashes", "csv")) ??
        "winkit_hashes.csv")
      : "winkit_hashes.csv";

    const chosen = await pickSaveFilePath({
      title: t.hashTool.saveCsvBtn,
      defaultPath,
      filters: [{ name: "CSV (*.csv)", extensions: ["csv"] }],
    });
    if (!chosen || !mountedRef.current || isFrontendShuttingDown()) return;

    if (latestSignatureRef.current !== snapshot.signature) {
      setIoBanner({ kind: "warn", text: t.hashTool.saveAbortedChanged });
      return;
    }

    await executeSaveBatchCsv(chosen, false, snapshot);
  };

  const handleClear = () => {
    textReqSeqRef.current += 1;
    if (activeAttemptIdRef.current) {
      void cancelBackendTask(activeAttemptIdRef.current);
      activeAttemptIdRef.current = null;
    }
    batchGenRef.current = ++hashBatchGenSeq;
    setCopiedKey(null);
    setIoBanner(null);
    setPendingOverwrite(null);
    setBatchFilter("all");
    setPageIndex(0);

    if (mode === "text") {
      updateHashSession({
        textInput: "",
        textDigests: null,
        textStatus: "idle",
        textErrorMessage: null,
        textExpectedHash: "",
      });
    } else {
      updateHashSession({
        batch: null,
      });
    }
  };

  const handleUpdateExpectedHash = (val: string) => {
    if (mode === "text") {
      updateHashSession({ textExpectedHash: val });
      return;
    }
    if (!selectedBatchItem) return;
    const targetId = selectedBatchItem.itemId;
    updateHashSession((prev) => {
      if (!prev.batch) return prev;
      return {
        ...prev,
        batch: {
          ...prev.batch,
          items: prev.batch.items.map((it) =>
            it.itemId === targetId ? { ...it, expectedHash: val } : it,
          ),
        },
      };
    });
  };

  const hasLegacySelected = (
    mode === "file" && batch ? batch.algorithmsSnapshot : selectedAlgorithms
  ).some(isLegacyCompatAlgorithm);

  const canCopyAll = mode === "text" ? visibleDigests.length > 0 : batchCounts.completed > 0;

  const rightStatusBadge = (() => {
    if (mode === "text") {
      if (textStatus === "completed") {
        return { cls: "badge-ok", label: t.hashTool.statusCompleted(visibleDigests.length) };
      }
      if (textStatus === "error") {
        return { cls: "badge-err", label: t.hashTool.statusError };
      }
      return { cls: "", label: t.hashTool.statusIdle };
    }
    if (!batch || !selectedBatchItem) {
      return { cls: "", label: t.hashTool.statusIdle };
    }
    if (batchNeedsAlgRecompute) {
      return { cls: "badge-partial", label: t.hashTool.statusStale };
    }
    if (selectedBatchItem.status === "completed") {
      return { cls: "badge-ok", label: t.hashTool.statusCompleted(visibleDigests.length) };
    }
    if (selectedBatchItem.status === "running") {
      const pct =
        selectedBatchItem.progressPercent !== null
          ? `${selectedBatchItem.progressPercent.toFixed(0)}%`
          : "…";
      return { cls: "", label: t.hashTool.statusRunning(pct) };
    }
    if (selectedBatchItem.status === "cancelled") {
      return { cls: "badge-partial", label: t.hashTool.itemStatusLabels.cancelled };
    }
    if (selectedBatchItem.status === "error") {
      return { cls: "badge-err", label: t.hashTool.statusError };
    }
    return { cls: "", label: t.hashTool.itemStatusLabels.pending };
  })();

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <div className="segmented" role="group" aria-label={t.hashTool.algorithmsLabel}>
            <button
              type="button"
              className={`segmented-btn ${mode === "text" ? "is-selected" : ""}`}
              aria-pressed={mode === "text"}
              onClick={() => handleSwitchMode("text")}
            >
              {t.hashTool.modeText}
            </button>
            <button
              type="button"
              className={`segmented-btn ${mode === "file" ? "is-selected" : ""}`}
              aria-pressed={mode === "file"}
              onClick={() => handleSwitchMode("file")}
            >
              {t.hashTool.modeFile}
            </button>
          </div>

          <div
            className="segmented"
            role="group"
            aria-label={t.hashTool.algorithmsLabel}
            style={{ flexWrap: "wrap" }}
          >
            {ALL_HASH_ALGORITHMS.map((alg) => {
              const checked = selectedAlgorithms.includes(alg);
              return (
                <button
                  key={alg}
                  type="button"
                  className={`segmented-btn mono ${checked ? "is-selected" : ""}`}
                  aria-pressed={checked}
                  onClick={() => handleToggleAlgorithm(alg)}
                >
                  {alg}
                </button>
              );
            })}
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={uppercase}
              onChange={(e) => updateHashSession({ uppercase: e.target.checked })}
            />
            <span>{t.hashTool.uppercaseLabel}</span>
          </label>

          {mode === "file" && (
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={csvFormulaProtection}
                onChange={(e) => updateHashSession({ csvFormulaProtection: e.target.checked })}
              />
              <span>{t.hashTool.formulaProtectionLabel}</span>
            </label>
          )}
        </div>

        <div className="tool-toolbar-group">
          {mode === "text" ? (
            <button
              type="button"
              className="btn"
              onClick={() => void runTextHash(textInput, selectedAlgorithms)}
            >
              <Play size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.hashTool.computeBtn}</span>
            </button>
          ) : isBatchRunning ? (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleCancelBatch()}
            >
              <Square size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.hashTool.cancelBtn}</span>
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => void handleSelectFiles()}>
                <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{t.hashTool.selectFileBtn}</span>
              </button>

              {batchCounts.incomplete > 0 && (
                <button type="button" className="btn btn-primary" onClick={handleResumeIncomplete}>
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.resumeIncompleteBtn(batchCounts.incomplete)}</span>
                </button>
              )}

              {batchCounts.error > 0 && (
                <button type="button" className="btn" onClick={handleRetryFailed}>
                  <RotateCcw size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.retryFailedBtn(batchCounts.error)}</span>
                </button>
              )}

              {batchNeedsAlgRecompute && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleRecomputeBatchWithSelectedAlgs}
                >
                  <Play size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.recomputeWithNewAlgsBtn}</span>
                </button>
              )}

              {batch && batch.items.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={isBatchRunning}
                  onClick={() => void handleSaveBatchCsv()}
                >
                  <Download size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.saveCsvBtn}</span>
                </button>
              )}
            </>
          )}

          <button
            type="button"
            className="btn btn-primary"
            disabled={!canCopyAll}
            onClick={() => void handleCopyAll()}
          >
            {copiedKey === "all" ? (
              <Check size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <Copy size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {copiedKey === "all"
                ? t.hashTool.copiedBadge
                : mode === "file" && batch && batch.items.length > 1
                  ? t.hashTool.copyBatchBtn(batchCounts.completed)
                  : visibleDigests.length > 1 || mode === "file"
                    ? t.hashTool.copyAllBtn
                    : t.hashTool.copyBtn}
            </span>
          </button>

          <button type="button" className="btn" onClick={handleClear}>
            <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{t.hashTool.clearBtn}</span>
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px 16px", alignItems: "center" }}>
        <p className="field-hint" style={{ margin: 0 }}>
          {t.hashTool.scopeNote}
        </p>
        {hasLegacySelected && (
          <span
            className="field-hint"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "4px",
              color: "var(--status-warn)",
            }}
          >
            <AlertTriangle size={13} strokeWidth={1.75} aria-hidden="true" />
            <span>MD5 / SHA-1：{t.hashTool.compatNote}</span>
          </span>
        )}
      </div>

      {ioBanner && (
        <div
          className={`status-banner ${
            ioBanner.kind === "ok" ? "is-ok" : ioBanner.kind === "warn" ? "is-warn" : "is-err"
          }`}
          role={ioBanner.kind === "err" ? "alert" : "status"}
        >
          <span>{ioBanner.text}</span>
        </div>
      )}

      {mode === "file" && batch && batch.overflowSkippedCount > 0 && (
        <div className="status-banner is-warn" role="alert">
          <span>
            {t.hashTool.batchOverflowNotice(MAX_HASH_BATCH_FILES, batch.overflowSkippedCount)}
          </span>
        </div>
      )}

      <div className="split-panes">
        {/* Left Pane: UTF-8 Text Input or Multi-File Queue */}
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            {mode === "text" ? (
              <>
                <label htmlFor={textInputId} className="pane-title">
                  {t.hashTool.textInputLabel}
                </label>
                <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-muted)" }}>
                  {t.hashTool.byteCount(liveTextBytes)}
                </span>
              </>
            ) : (
              <>
                <span className="pane-title">{t.hashTool.modeFile}</span>
                {batch && (
                  <span className="badge mono">
                    {t.hashTool.batchAlgSnapshotLabel(batch.algorithmsSnapshot.join(", "))}
                  </span>
                )}
              </>
            )}
          </div>

          {mode === "text" ? (
            <>
              <textarea
                id={textInputId}
                className="code-editor"
                placeholder={t.hashTool.textPlaceholder}
                spellCheck={false}
                value={textInput}
                onChange={(e) => {
                  const val = e.target.value;
                  updateHashSession({ textInput: val });
                  void runTextHash(val, selectedAlgorithms);
                }}
              />
              <div
                style={{
                  padding: "8px 12px",
                  borderTop: "1px solid var(--border-subtle)",
                  background: "var(--bg-subtle)",
                }}
              >
                <p className="field-hint">{t.hashTool.exactBytesNote}</p>
              </div>
            </>
          ) : !batch || batch.items.length === 0 ? (
            <div
              style={{
                padding: "20px",
                display: "flex",
                flexDirection: "column",
                gap: "12px",
                flex: 1,
                justifyContent: "center",
              }}
            >
              <div className="empty-state" style={{ borderStyle: "dashed" }}>
                <p style={{ margin: "0 0 12px" }}>{t.hashTool.dropFileHint}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => void handleSelectFiles()}
                >
                  <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.hashTool.selectFileBtn}</span>
                </button>
              </div>
            </div>
          ) : (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                flex: 1,
                minHeight: 0,
              }}
            >
              {/* Batch Summary & Progress Header */}
              <div
                style={{
                  padding: "10px 14px",
                  borderBottom: "1px solid var(--border-subtle)",
                  background: "var(--bg-subtle)",
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    flexWrap: "wrap",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span className="mono" style={{ fontSize: "12px", fontWeight: 600 }}>
                    {t.hashTool.batchSummaryCounts(
                      batchCounts.total,
                      batchCounts.completed,
                      batchCounts.running,
                      batchCounts.pending,
                      batchCounts.error,
                      batchCounts.cancelled,
                    )}
                  </span>

                  <div className="segmented" role="group">
                    {(
                      [
                        ["all", t.hashTool.filterAll],
                        ["incomplete", t.hashTool.filterIncomplete],
                        ["error", t.hashTool.filterError],
                        ["completed", t.hashTool.filterCompleted],
                      ] as const
                    ).map(([fKey, fLabel]) => (
                      <button
                        key={fKey}
                        type="button"
                        className={`segmented-btn ${batchFilter === fKey ? "is-selected" : ""}`}
                        onClick={() => {
                          setBatchFilter(fKey);
                          setPageIndex(0);
                        }}
                      >
                        {fLabel}
                      </button>
                    ))}
                  </div>
                </div>

                {isBatchRunning && (
                  <div
                    className="progress-track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      className="progress-fill"
                      style={{
                        width: `${Math.max(2, Math.min(100, batchOverallPercent))}%`,
                      }}
                    />
                  </div>
                )}

                {batchCounts.incomplete > 0 && !isBatchRunning && (
                  <p className="field-hint" style={{ margin: 0 }}>
                    {t.hashTool.batchResumeRuleNote}
                  </p>
                )}
              </div>

              {/* Paginated File Queue List */}
              <div
                role="listbox"
                aria-label={t.hashTool.modeFile}
                style={{
                  flex: 1,
                  overflowY: "auto",
                  padding: "8px 10px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                }}
              >
                {pagedBatchItems.map((item) => {
                  const isSelected = selectedBatchItem?.itemId === item.itemId;
                  const itemCmp = item.expectedHash.trim()
                    ? compareMultiDigests(
                        item.status === "completed" ? item.digests : null,
                        batch.algorithmsSnapshot,
                        item.expectedHash,
                      )
                    : null;

                  const statusBadgeCls =
                    item.status === "completed"
                      ? "badge-ok"
                      : item.status === "error"
                        ? "badge-err"
                        : item.status === "cancelled"
                          ? "badge-partial"
                          : "";

                  return (
                    <button
                      key={item.itemId}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-testid={`hash-file-row-${item.itemId}`}
                      onClick={() =>
                        updateHashSession((prev) =>
                          prev.batch
                            ? { ...prev, batch: { ...prev.batch, selectedItemId: item.itemId } }
                            : prev,
                        )
                      }
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: isSelected
                          ? "1px solid var(--accent)"
                          : "1px solid var(--border-subtle)",
                        background: isSelected ? "var(--accent-subtle)" : "var(--bg-elevated)",
                        cursor: "pointer",
                        display: "flex",
                        flexDirection: "column",
                        gap: "4px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <span
                          className="mono"
                          style={{
                            fontWeight: 600,
                            fontSize: "12.5px",
                            color: "var(--text-primary)",
                            wordBreak: "break-all",
                          }}
                        >
                          {item.fileName}
                        </span>
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "6px",
                            flexShrink: 0,
                          }}
                        >
                          {itemCmp && itemCmp.kind !== "idle" && (
                            <span
                              className={`badge ${
                                itemCmp.kind === "match"
                                  ? "badge-ok"
                                  : itemCmp.kind === "mismatch"
                                    ? "badge-err"
                                    : "badge-partial"
                              }`}
                            >
                              {itemCmp.kind === "match"
                                ? t.hashTool.compareRowBadges.match
                                : itemCmp.kind === "mismatch"
                                  ? t.hashTool.compareRowBadges.mismatch
                                  : itemCmp.kind === "candidate_uncomputed"
                                    ? t.hashTool.compareRowBadges.uncomputed
                                    : itemCmp.kind === "ambiguous_format"
                                      ? t.hashTool.compareRowBadges.ambiguous
                                      : t.hashTool.compareRowBadges.invalid}
                            </span>
                          )}
                          <span className={`badge ${statusBadgeCls}`}>
                            {item.status === "running" && item.progressPercent !== null
                              ? `${t.hashTool.itemStatusLabels.running} ${item.progressPercent.toFixed(0)}%`
                              : t.hashTool.itemStatusLabels[item.status]}
                          </span>
                        </div>
                      </div>

                      <div
                        className="mono"
                        style={{
                          fontSize: "11px",
                          color: "var(--text-muted)",
                          wordBreak: "break-all",
                          display: "flex",
                          justifyContent: "space-between",
                          gap: "8px",
                        }}
                      >
                        <span>{extractParentDirHint(item.path)}</span>
                        {item.byteLength !== null && (
                          <span style={{ flexShrink: 0 }}>{formatByteSize(item.byteLength)}</span>
                        )}
                      </div>

                      {item.status === "error" && item.errorMessage && (
                        <div
                          style={{
                            fontSize: "11.5px",
                            color: "var(--status-err)",
                            wordBreak: "break-word",
                          }}
                        >
                          {item.errorMessage}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {filteredBatchItems.length > HASH_BATCH_PAGE_SIZE && (
                <div
                  style={{
                    padding: "8px 12px",
                    borderTop: "1px solid var(--border-subtle)",
                    background: "var(--bg-subtle)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: "8px",
                  }}
                >
                  <span className="field-hint mono">
                    {t.hashTool.pageInfo(
                      pageStartIdx + 1,
                      Math.min(filteredBatchItems.length, pageStartIdx + pagedBatchItems.length),
                      filteredBatchItems.length,
                    )}
                  </span>
                  <div style={{ display: "flex", gap: "6px" }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={clampedPage <= 0}
                      onClick={() => setPageIndex((p) => Math.max(0, p - 1))}
                    >
                      {t.hashTool.prevPageBtn}
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={clampedPage >= totalPages - 1}
                      onClick={() => setPageIndex((p) => Math.min(totalPages - 1, p + 1))}
                    >
                      {t.hashTool.nextPageBtn}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Right Pane: Selected Item / Text Digests & Bound Expected Digest Verification */}
        <div className="pane">
          <div className="pane-header">
            <span className="pane-title">{t.hashTool.digestLabel}</span>
            <span className={`badge ${rightStatusBadge.cls}`}>{rightStatusBadge.label}</span>
          </div>

          <div
            style={{
              padding: "14px 16px",
              display: "flex",
              flexDirection: "column",
              gap: "12px",
              flex: 1,
              overflowY: "auto",
            }}
          >
            {mode === "file" && selectedBatchItem && (
              <div
                className="mono"
                style={{
                  padding: "8px 10px",
                  borderRadius: "6px",
                  background: "var(--bg-subtle)",
                  border: "1px solid var(--border-subtle)",
                  wordBreak: "break-all",
                  fontSize: "12px",
                }}
              >
                <div>
                  <strong>{selectedBatchItem.fileName}</strong>
                </div>
                <div style={{ color: "var(--text-muted)", marginTop: "2px" }}>
                  {selectedBatchItem.path}
                </div>
                {selectedBatchItem.byteLength !== null && (
                  <div style={{ color: "var(--text-muted)", marginTop: "2px" }}>
                    {t.hashTool.fileSizeLabel}: {formatByteSize(selectedBatchItem.byteLength)} (
                    {selectedBatchItem.byteLength.toLocaleString()} B)
                  </div>
                )}
              </div>
            )}

            {mode === "file" && batchNeedsAlgRecompute && (
              <div className="status-banner is-warn" role="status">
                <span>{t.hashTool.staleNotice}</span>
              </div>
            )}

            {mode === "text" && textStatus === "error" && textErrorMessage && (
              <div className="status-banner is-err" role="alert">
                <span>{textErrorMessage}</span>
              </div>
            )}

            {mode === "file" &&
              selectedBatchItem?.status === "error" &&
              selectedBatchItem.errorMessage && (
                <div className="status-banner is-err" role="alert">
                  <span>{selectedBatchItem.errorMessage}</span>
                </div>
              )}

            {mode === "file" && selectedBatchItem?.status === "cancelled" && (
              <div className="status-banner is-warn" role="status">
                <span>{t.hashTool.statusCancelled}</span>
              </div>
            )}

            {visibleDigests.length === 0 ? (
              <div
                style={{
                  padding: "18px 12px",
                  borderRadius: "6px",
                  border: "1px dashed var(--border-subtle)",
                  background: "var(--bg-subtle)",
                  color: "var(--text-muted)",
                  fontSize: "12.5px",
                  textAlign: "center",
                }}
              >
                {t.hashTool.emptyDigestsHint}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                {visibleDigests.map((item) => {
                  const rowKey = `alg-${item.algorithm}`;
                  const isLegacy = isLegacyCompatAlgorithm(item.algorithm);
                  return (
                    <div
                      key={item.algorithm}
                      style={{
                        padding: "8px 10px",
                        borderRadius: "6px",
                        border: "1px solid var(--border-subtle)",
                        background: "var(--bg-subtle)",
                        display: "flex",
                        flexDirection: "column",
                        gap: "5px",
                      }}
                    >
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: "8px",
                          flexWrap: "wrap",
                        }}
                      >
                        <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                          <span className="badge mono">{item.algorithm}</span>
                          <span className="field-hint mono">{item.hexLength} hex</span>
                          {isLegacy && (
                            <span className="badge badge-partial" title={t.hashTool.compatNote}>
                              Compat
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          className="btn"
                          style={{ height: "26px", padding: "0 8px", fontSize: "12px" }}
                          aria-label={`${t.hashTool.copyBtn} ${item.algorithm}`}
                          onClick={() => void copyWithFeedback(rowKey, item.formatted)}
                        >
                          {copiedKey === rowKey ? (
                            <Check size={12} strokeWidth={1.75} aria-hidden="true" />
                          ) : (
                            <Copy size={12} strokeWidth={1.75} aria-hidden="true" />
                          )}
                          <span>
                            {copiedKey === rowKey ? t.hashTool.copiedBadge : t.hashTool.copyBtn}
                          </span>
                        </button>
                      </div>
                      <div
                        className="mono"
                        data-testid={`digest-${item.algorithm}`}
                        style={{
                          fontSize: "12px",
                          lineHeight: "18px",
                          wordBreak: "break-all",
                          overflowX: "auto",
                          userSelect: "all",
                          color: "var(--text-primary)",
                        }}
                      >
                        {item.formatted}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="field-stack" style={{ marginTop: "auto" }}>
              <label htmlFor={compareInputId} className="field-label">
                {t.hashTool.compareLabel}
              </label>
              <input
                id={compareInputId}
                type="text"
                className="text-input mono"
                spellCheck={false}
                disabled={mode === "file" && !selectedBatchItem}
                value={activeExpectedHash}
                placeholder={t.hashTool.comparePlaceholder}
                onChange={(e) => handleUpdateExpectedHash(e.target.value)}
              />

              {compareResult.kind === "idle" && (
                <p className="field-hint">{t.hashTool.compareIdle}</p>
              )}
              {compareResult.kind === "ambiguous_format" && (
                <div className="status-banner is-warn" role="alert">
                  <span>{t.hashTool.compareAmbiguousFormat}</span>
                </div>
              )}
              {compareResult.kind === "invalid_format" && (
                <div className="status-banner is-warn" role="alert">
                  <span>
                    {compareResult.reason === "prefix_length_mismatch"
                      ? t.hashTool.comparePrefixMismatch
                      : t.hashTool.compareInvalidFormat}
                  </span>
                </div>
              )}
              {compareResult.kind === "candidate_uncomputed" && (
                <div className="status-banner is-warn" role="status">
                  <span>
                    {t.hashTool.compareUncomputedCandidate(
                      compareResult.candidateAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
              {compareResult.kind === "match" && (
                <div className="status-banner is-ok" role="status" aria-live="polite">
                  <span>
                    {t.hashTool.compareMatch(
                      compareResult.matchedAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
              {compareResult.kind === "mismatch" && (
                <div className="status-banner is-err" role="alert">
                  <span>
                    {t.hashTool.compareMismatch(
                      compareResult.candidateAlgorithm,
                      compareResult.hexLength,
                    )}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={Boolean(pendingOverwrite)}
        title={t.hashTool.overwriteConfirmTitle}
        body={pendingOverwrite ? t.hashTool.overwriteConfirmBody(pendingOverwrite.targetPath) : ""}
        confirmLabel={t.hashTool.overwriteConfirmAccept}
        cancelLabel={t.hashTool.cancel}
        onCancel={() => setPendingOverwrite(null)}
        onConfirm={() => {
          if (pendingOverwrite) {
            void executeSaveBatchCsv(pendingOverwrite.targetPath, true, pendingOverwrite.snapshot);
          }
        }}
      />
    </div>
  );
}
