import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  RotateCw,
  ScanText,
  Square,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  captureScreenRegion,
  formatLocalizedError,
  getOcrEngineStatus,
  ocrExtractBatch,
  parseBackendError,
  pickSaveFilePath,
  saveLocalTextFile,
  subscribeCaptureProgress,
  subscribeOcrProgress,
  writeSystemClipboardText,
  type CaptureRect,
  type OcrTextLine,
} from "../../lib/tauriBridge";
import "../extract-text/extractText.css";
import "./captureText.css";

export function CaptureTextWorkspace() {
  const { locale, t } = useI18n();
  const zh = locale === "zh-CN";
  const { pdfSession, updateCaptureTextSession } = usePdfSession();
  const state = pdfSession.captureText;

  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const seqRef = useRef(1);

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
        updateCaptureTextSession((prev) => ({ ...prev, engineStatus: status }));
      })
      .catch((err) => {
        if (!active) return;
        updateCaptureTextSession((prev) => ({
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
  }, [t, updateCaptureTextSession]);

  // Subscribe to region capture progress (countdown / selecting)
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeCaptureProgress((payload) => {
          updateCaptureTextSession((prev) =>
            prev.activeTaskId === payload.taskId ? { ...prev, captureProgress: payload } : prev,
          );
        }),
      "t04-capture-progress",
    );
  }, [updateCaptureTextSession]);

  // Subscribe to OCR worker progress
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeOcrProgress((payload) => {
          updateCaptureTextSession((prev) =>
            prev.activeTaskId === payload.taskId ? { ...prev, ocrProgress: payload } : prev,
          );
        }),
      "t04-ocr-progress",
    );
  }, [updateCaptureTextSession]);

  const runOcrOnAsset = useCallback(
    async (assetId: string, rect: CaptureRect) => {
      const cur = stateRef.current;
      const ocrTaskId = `t04-ocr-${Date.now()}-${seqRef.current++}`;
      updateCaptureTextSession((prev) => ({
        ...prev,
        phase: "recognizing",
        activeTaskId: ocrTaskId,
        captureProgress: null,
        ocrProgress: {
          taskId: ocrTaskId,
          currentItem: 1,
          totalItems: 1,
          currentPage: 1,
          totalPages: 1,
          label: zh
            ? `屏幕区域 (${rect.width}×${rect.height})`
            : `Screen (${rect.width}×${rect.height})`,
          percent: 10,
          state: "running",
        },
        notice: null,
        errorMessage: null,
      }));

      try {
        const batchRes = await ocrExtractBatch(
          ocrTaskId,
          {
            items: [
              {
                id: "t04-region",
                path: null,
                assetId,
                name: `screen_${rect.width}x${rect.height}.png`,
                pageRange: null,
              },
            ],
            pdfDpi: 200,
            options: {
              maxSideLen: cur.maxSideLen,
              includePreview: false,
            },
          },
          "T04",
        );

        if (batchRes.cancelled) {
          updateCaptureTextSession((prev) => ({
            ...prev,
            phase: "idle",
            activeTaskId: null,
            ocrProgress: null,
            notice: zh
              ? "已取消本次离线识别，可点击「重新识别」或再次框选。"
              : "Recognition cancelled. Click Re-run OCR or capture a new region.",
          }));
          return;
        }

        const item = batchRes.items[0];
        if (!item || item.status === "failed") {
          updateCaptureTextSession((prev) => ({
            ...prev,
            phase: "idle",
            activeTaskId: null,
            ocrProgress: null,
            errorMessage:
              item?.errorMessage ?? (zh ? "离线识别失败。" : "Offline recognition failed."),
          }));
          return;
        }

        const page = item.pages[0] ?? null;
        const text = page?.text ?? "";
        let autoCopied = false;
        if (stateRef.current.autoCopy && text.trim().length > 0) {
          try {
            await writeSystemClipboardText(text);
            autoCopied = true;
          } catch {
            // Keep recognized text visible even if clipboard is momentarily busy
          }
        }

        updateCaptureTextSession((prev) => ({
          ...prev,
          phase: "idle",
          activeTaskId: null,
          ocrProgress: null,
          lastPage: page,
          editedText: null,
          selectedLineIndex: null,
          notice:
            text.trim().length === 0
              ? zh
                ? "所选区域未检测到文字，可尝试放大选区或切换「1600 px（小字增强）」后重新识别。"
                : "No text detected in the selected area. Try a larger region or 1600 px mode."
              : autoCopied
                ? zh
                  ? `识别完成（${page?.lineCount ?? 0} 行），已自动复制到系统剪贴板。`
                  : `Recognized ${page?.lineCount ?? 0} lines and copied to clipboard.`
                : null,
        }));
      } catch (err) {
        const parsed = parseBackendError(err);
        if (parsed.code === "TASK_CANCELLED") {
          updateCaptureTextSession((prev) => ({
            ...prev,
            phase: "idle",
            activeTaskId: null,
            ocrProgress: null,
            notice: zh
              ? "已取消本次离线识别，可点击「重新识别」或再次框选。"
              : "Recognition cancelled. Click Re-run OCR or capture a new region.",
          }));
        } else {
          updateCaptureTextSession((prev) => ({
            ...prev,
            phase: "idle",
            activeTaskId: null,
            ocrProgress: null,
            errorMessage: formatLocalizedError(err, t),
          }));
        }
      }
    },
    [t, updateCaptureTextSession, zh],
  );

  const handleCaptureRegionText = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.phase !== "idle" || cur.engineStatus?.ready === false) return;

    const capTaskId = `t04-cap-${Date.now()}-${seqRef.current++}`;
    updateCaptureTextSession((prev) => ({
      ...prev,
      phase: "capturing",
      activeTaskId: capTaskId,
      captureProgress: null,
      ocrProgress: null,
      notice: null,
      errorMessage: null,
    }));

    try {
      const cap = await captureScreenRegion(capTaskId, {
        countdownSeconds: cur.countdownSeconds,
        includeCursor: false,
        hideMainWindow: cur.hideMainWindow,
        promptText: zh
          ? "拖动框选屏幕文字区域 · 松开即离线识别 · 按 Esc 或右键取消"
          : "Drag to select screen text · Release for offline OCR · Esc or right-click cancels",
        toolId: "T04",
      });

      updateCaptureTextSession((prev) => ({
        ...prev,
        lastCapture: cap,
        lastPage: null,
        editedText: null,
        selectedLineIndex: null,
        captureProgress: null,
      }));

      await runOcrOnAsset(cap.asset.assetId, cap.rect);
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TASK_CANCELLED") {
        updateCaptureTextSession((prev) => ({
          ...prev,
          phase: "idle",
          activeTaskId: null,
          captureProgress: null,
          notice: zh
            ? "已取消屏幕框选，剪贴板内容未修改。"
            : "Screen selection cancelled; clipboard unchanged.",
        }));
      } else {
        updateCaptureTextSession((prev) => ({
          ...prev,
          phase: "idle",
          activeTaskId: null,
          captureProgress: null,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    }
  }, [runOcrOnAsset, t, updateCaptureTextSession, zh]);

  const handleRerunCurrentCapture = useCallback(async () => {
    const cur = stateRef.current;
    if (cur.phase !== "idle" || !cur.lastCapture || cur.engineStatus?.ready === false) return;
    await runOcrOnAsset(cur.lastCapture.asset.assetId, cur.lastCapture.rect);
  }, [runOcrOnAsset]);

  const handleCancelActive = useCallback(async () => {
    const tid = stateRef.current.activeTaskId;
    if (!tid) return;
    await cancelBackendTask(tid).catch(() => {});
  }, []);

  const handleClear = useCallback(() => {
    if (stateRef.current.phase !== "idle") return;
    updateCaptureTextSession((prev) => ({
      ...prev,
      lastCapture: null,
      lastPage: null,
      editedText: null,
      selectedLineIndex: null,
      notice: null,
      errorMessage: null,
    }));
  }, [updateCaptureTextSession]);

  const displayText = state.editedText ?? state.lastPage?.text ?? "";

  const handleCopyText = useCallback(
    async (text: string, label: string) => {
      if (!text) return;
      try {
        await writeSystemClipboardText(text);
        showToast(setCopyFeedback, label);
      } catch (err) {
        updateCaptureTextSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [showToast, t, updateCaptureTextSession],
  );

  const handleExportTxt = useCallback(async () => {
    if (!displayText) return;
    const outPath = await pickSaveFilePath({
      title: zh ? "导出取字文本 (.txt)" : "Export Captured Text (.txt)",
      defaultPath: "screen_capture_text.txt",
      filters: [{ name: "Text", extensions: ["txt"] }],
    });
    if (!outPath) return;
    try {
      await saveLocalTextFile({
        outputPath: outPath,
        sourcePath: null,
        content: displayText,
        overwrite: true,
        toolId: "T04",
      });
      showToast(setSaveNotice, zh ? "已导出 .txt" : "Exported .txt");
    } catch (err) {
      updateCaptureTextSession((prev) => ({
        ...prev,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  }, [displayText, showToast, t, updateCaptureTextSession, zh]);

  const isBusy = state.phase !== "idle";
  const capture = state.lastCapture;
  const page = state.lastPage;

  return (
    <div className="ocr-workspace">
      <div className="ocr-toolbar">
        <div className="ocr-toolbar-group">
          {!isBusy ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={state.engineStatus?.ready === false}
                onClick={() => void handleCaptureRegionText()}
              >
                <Crop size={15} strokeWidth={1.75} aria-hidden="true" />
                <span>{zh ? "框选屏幕区域取字" : "Capture Screen Text"}</span>
              </button>
              {capture && (
                <button
                  type="button"
                  className="btn"
                  disabled={state.engineStatus?.ready === false}
                  onClick={() => void handleRerunCurrentCapture()}
                >
                  <RotateCw size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{zh ? "重新识别" : "Re-run OCR"}</span>
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => void handleCancelActive()}
            >
              <Square size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>
                {state.phase === "capturing"
                  ? zh
                    ? "取消框选"
                    : "Cancel Capture"
                  : zh
                    ? "取消识别"
                    : "Cancel OCR"}
              </span>
            </button>
          )}

          {capture && !isBusy && (
            <button type="button" className="btn" onClick={handleClear}>
              <Trash2 size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{zh ? "清空" : "Clear"}</span>
            </button>
          )}
        </div>

        <div className="ocr-toolbar-group t04-options-row">
          <label className="ocr-inline-field">
            <span>{zh ? "延迟" : "Delay"}</span>
            <select
              className="ocr-select"
              value={state.countdownSeconds}
              disabled={isBusy}
              onChange={(e) =>
                updateCaptureTextSession((prev) => ({
                  ...prev,
                  countdownSeconds: Number(e.target.value) as 0 | 2 | 3,
                }))
              }
            >
              <option value={0}>{zh ? "立即" : "None"}</option>
              <option value={2}>{zh ? "2 秒" : "2s"}</option>
              <option value={3}>{zh ? "3 秒" : "3s"}</option>
            </select>
          </label>
          <label className="ocr-inline-field">
            <span>{zh ? "识别精度" : "Det Max"}</span>
            <select
              className="ocr-select"
              value={state.maxSideLen}
              disabled={isBusy}
              onChange={(e) =>
                updateCaptureTextSession((prev) => ({
                  ...prev,
                  maxSideLen: Number(e.target.value) as 1280 | 1600,
                }))
              }
            >
              <option value={1280}>{zh ? "1280 px（均衡）" : "1280 px (Balanced)"}</option>
              <option value={1600}>{zh ? "1600 px（小字增强）" : "1600 px (Small Text)"}</option>
            </select>
          </label>
          <label className="t04-checkbox">
            <input
              type="checkbox"
              checked={state.hideMainWindow}
              disabled={isBusy}
              onChange={(e) =>
                updateCaptureTextSession((prev) => ({
                  ...prev,
                  hideMainWindow: e.target.checked,
                }))
              }
            />
            <span>{zh ? "框选时隐藏主窗口" : "Hide window"}</span>
          </label>
          <label className="t04-checkbox">
            <input
              type="checkbox"
              checked={state.autoCopy}
              disabled={isBusy}
              onChange={(e) =>
                updateCaptureTextSession((prev) => ({
                  ...prev,
                  autoCopy: e.target.checked,
                }))
              }
            />
            <span>{zh ? "识别后自动复制" : "Auto-copy"}</span>
          </label>
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
                ? "RapidOCR PP-OCRv4 · 内存零落盘"
                : "RapidOCR PP-OCRv4 · In-Memory"}
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

      {state.notice && !isBusy && (
        <div className="ocr-banner info" role="status">
          <span>{state.notice}</span>
        </div>
      )}

      {state.phase === "capturing" && (
        <div className="ocr-banner info" role="status">
          <span>
            {state.captureProgress?.phase === "countdown" &&
            state.captureProgress.countdownRemaining
              ? zh
                ? `倒计时 ${state.captureProgress.countdownRemaining} 秒后进入框选（按 Esc 取消）…`
                : `Selecting in ${state.captureProgress.countdownRemaining}s (Esc to cancel)…`
              : zh
                ? "请在屏幕上拖动框选目标文字区域（支持多屏与混合 DPI，按 Esc 或右键取消）…"
                : "Drag on screen to select a text area (multi-monitor & mixed-DPI aware; Esc or right-click cancels)…"}
          </span>
        </div>
      )}

      {state.phase === "recognizing" && (
        <div className="ocr-progress-bar" aria-live="polite">
          <div className="ocr-progress-row">
            <span>
              {zh
                ? `正在本地离线识别所选区域：${state.ocrProgress?.label ?? ""}`
                : `Recognizing selected area offline: ${state.ocrProgress?.label ?? ""}`}
            </span>
            <span>{Math.round(state.ocrProgress?.percent ?? 15)}%</span>
          </div>
          <div className="ocr-progress-track">
            <div
              className="ocr-progress-fill"
              style={{
                width: `${Math.min(100, Math.max(10, state.ocrProgress?.percent ?? 15))}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="ocr-main-grid">
        {/* Left: Captured Screen Region Preview + Interactive Boxes */}
        <section className="ocr-panel" aria-label={zh ? "框选区域预览" : "Captured Region Preview"}>
          <div className="ocr-panel-header">
            <span>{zh ? "框选区域预览" : "Captured Region"}</span>
            <div className="ocr-panel-actions">
              {capture && (
                <span className="t04-region-badge">
                  ({capture.rect.x}, {capture.rect.y}) · {capture.rect.width}×{capture.rect.height}{" "}
                  px
                </span>
              )}
              {page && page.lines.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    updateCaptureTextSession((prev) => ({
                      ...prev,
                      showBoxes: !prev.showBoxes,
                    }))
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
            {capture ? (
              <div className="ocr-canvas-frame">
                <img
                  src={capture.asset.dataUrl}
                  alt={zh ? "屏幕框选截图预览" : "Captured screen region"}
                  className="ocr-preview-img"
                />
                {state.showBoxes && page && page.lines.length > 0 && (
                  <svg
                    className="ocr-overlay-svg"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                    aria-label={zh ? "识别文字位置框" : "Recognized text regions"}
                  >
                    {page.lines.map((line: OcrTextLine) => {
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
                            updateCaptureTextSession((prev) => ({
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
                <Crop size={32} strokeWidth={1.5} aria-hidden="true" />
                <div>
                  {zh
                    ? "点击「框选屏幕区域取字」，拖动选定屏幕上任意文字区域"
                    : "Click Capture Screen Text and drag over any text on your screen"}
                </div>
                <div className="t04-empty-steps">
                  <span className="t04-step-chip">
                    {zh ? "1. 多屏 / 混合 DPI 框选" : "1. Multi-monitor select"}
                  </span>
                  <span className="t04-step-chip">
                    {zh ? "2. 内存直传 RapidOCR" : "2. In-memory RapidOCR"}
                  </span>
                  <span className="t04-step-chip">
                    {zh ? "3. 预览校对 · 一键复制" : "3. Preview & one-click copy"}
                  </span>
                </div>
              </div>
            )}
          </div>

          {page && (
            <div className="ocr-footer-bar">
              <span>
                {page.imageWidthPx}×{page.imageHeightPx} px
              </span>
              <span>
                {zh
                  ? `${page.lineCount} 行 · 平均置信度 ${(page.averageConfidence * 100).toFixed(1)}% · ${page.elapsedMs} ms`
                  : `${page.lineCount} lines · Avg conf ${(page.averageConfidence * 100).toFixed(1)}% · ${page.elapsedMs} ms`}
              </span>
            </div>
          )}
        </section>

        {/* Right: Recognized Text Preview + One-Click Copy + Coordinates */}
        <section className="ocr-panel" aria-label={zh ? "取字结果" : "Captured Text Result"}>
          <div className="ocr-panel-header">
            <div className="ocr-tabs" role="tablist">
              <button
                type="button"
                role="tab"
                aria-selected={state.rightTab === "text"}
                className={`ocr-tab-btn ${state.rightTab === "text" ? "active" : ""}`}
                onClick={() => updateCaptureTextSession((prev) => ({ ...prev, rightTab: "text" }))}
              >
                {zh ? "识别文本" : "Extracted Text"}
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={state.rightTab === "boxes"}
                className={`ocr-tab-btn ${state.rightTab === "boxes" ? "active" : ""}`}
                onClick={() => updateCaptureTextSession((prev) => ({ ...prev, rightTab: "boxes" }))}
              >
                {zh
                  ? `逐行坐标 (${page?.lineCount ?? 0})`
                  : `Lines & Boxes (${page?.lineCount ?? 0})`}
              </button>
            </div>

            <div className="ocr-panel-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={!displayText}
                onClick={() =>
                  void handleCopyText(displayText, zh ? "已复制到剪贴板" : "Copied to clipboard")
                }
              >
                {copyFeedback ? <Check size={14} /> : <Copy size={14} />}
                <span>{copyFeedback ?? (zh ? "一键复制" : "Copy Text")}</span>
              </button>
              <button
                type="button"
                className="btn"
                disabled={!displayText}
                onClick={() => void handleExportTxt()}
              >
                <Download size={14} />
                <span>.txt</span>
              </button>
            </div>
          </div>

          {state.rightTab === "text" ? (
            <textarea
              className="ocr-textarea"
              value={displayText}
              aria-label={zh ? "屏幕取字识别结果" : "Captured screen text result"}
              placeholder={
                zh
                  ? "框选屏幕区域后，本地离线识别结果会直接显示在这里，可快速校对并点击「一键复制」..."
                  : "Captured text will appear here for quick review and one-click copy..."
              }
              onChange={(e) => {
                const val = e.target.value;
                updateCaptureTextSession((prev) => ({ ...prev, editedText: val }));
              }}
            />
          ) : (
            <div className="ocr-lines-list">
              {!page || page.lines.length === 0 ? (
                <div style={{ padding: 20, color: "var(--text-secondary)", fontSize: 13 }}>
                  {zh
                    ? "完成区域取字后，可在此查看每行文字、置信度、框选内像素坐标与词级 Span。"
                    : "Run a capture to inspect each recognized line, confidence, coordinates, and token spans."}
                </div>
              ) : (
                page.lines.map((line) => {
                  const isSel = state.selectedLineIndex === line.index;
                  return (
                    <div
                      key={line.index}
                      className={`ocr-line-row ${isSel ? "selected" : ""}`}
                      onClick={() =>
                        updateCaptureTextSession((prev) => ({
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
                        {Math.round(line.bboxPx.width)}×{Math.round(line.bboxPx.height)}) ·{" "}
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
                  ? "截图像素与识别文字仅驻留当前会话内存，绝不自动写入磁盘或上传云端"
                  : "Captured pixels and text stay in session memory only and are never persisted or uploaded"}
            </span>
            {page && (
              <span>{zh ? `${displayText.length} 字符` : `${displayText.length} chars`}</span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
