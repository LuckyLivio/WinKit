import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../../i18n/I18nContext";
import {
  bindDisposableListener,
  openLocalDirectory,
  pickMultipleDirectories,
  pickMultipleFiles,
  pickSingleDirectory,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import {
  formatImageBytes,
  formatImageFormatLabel,
  formatImageWarningText,
  IMAGE_FILE_DIALOG_EXTENSIONS,
  type BatchImageJobResponse,
  type BatchImageOutcomeStatus,
  type ImageBatchProgressPayload,
  type InspectedImageItem,
} from "./imageBatchModel";
import "./imageBatchShell.css";

interface ImageBatchShellProps {
  toolId: string;
  items: readonly InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  busy: boolean;
  inspecting: boolean;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
  executeLabel: string;
  executeDisabled?: boolean;
  emptyTitle: string;
  emptyBody: string;
  onAddPaths: (paths: string[]) => void;
  onSelectPath: (path: string) => void;
  onRemovePath: (path: string) => void;
  onClear: () => void;
  onChooseOutputDir: (dir: string) => void;
  onExecute: () => void;
  onCancel: () => void;
  renderPreview: (selected: InspectedImageItem | null) => ReactNode;
  renderControls: () => ReactNode;
  renderItemBadge?: (item: InspectedImageItem) => ReactNode;
}

const copy = {
  "zh-CN": {
    addImages: "添加图片",
    addFolders: "添加文件夹",
    clearList: "清空列表",
    pickImagesTitle: "选择一张或多张图片",
    pickFoldersTitle: "选择包含图片的文件夹",
    pickOutputTitle: "选择导出输出目录（自动写入新文件，绝不覆盖原图）",
    outputDirLabel: "输出目录",
    outputDirPlaceholder: "请选择导出文件夹（不会覆盖原图或已有同名文件）",
    chooseOutputBtn: "选择目录…",
    cancelBtn: "取消任务",
    openOutputBtn: "打开输出目录",
    inspectingText: "正在读取图片信息与缩略图…",
    queueCount: (n: number) => `共 ${n} 张图片`,
    progressText: (cur: number, total: number, name: string) =>
      `正在处理第 ${cur}/${total} 张：${name}`,
    removeAria: (name: string) => `移除 ${name}`,
    resultTitle: "批量处理结果",
    resultSummary: (ok: number, kept: number, skip: number, fail: number, cancelled: boolean) =>
      `${cancelled ? "已取消 · " : ""}成功 ${ok}${kept > 0 ? ` · 未节省保留原件 ${kept}` : ""}${skip > 0 ? ` · 跳过 ${skip}` : ""}${fail > 0 ? ` · 失败 ${fail}` : ""}`,
    colFile: "文件",
    colStatus: "状态",
    colSize: "原大小 → 输出",
    colDims: "输出尺寸",
    colNote: "编码 / 说明",
    statusLabels: {
      ok: "已完成",
      kept_original: "未节省空间",
      skipped: "已跳过",
      error: "失败",
    } as Record<BatchImageOutcomeStatus, string>,
    savedLabel: (pct: number) =>
      pct > 0 ? `节省 ${pct.toFixed(1)}%` : pct < 0 ? `+${Math.abs(pct).toFixed(1)}%` : "0%",
    errTag: "无法读取",
    orientTag: (o: number) => `EXIF 方向 ${o}`,
  },
  "en-US": {
    addImages: "Add Images",
    addFolders: "Add Folders",
    clearList: "Clear",
    pickImagesTitle: "Select one or more images",
    pickFoldersTitle: "Select folders containing images",
    pickOutputTitle: "Choose output folder (writes new files, never overwrites originals)",
    outputDirLabel: "Output folder",
    outputDirPlaceholder: "Choose an output folder (never overwrites originals or existing files)",
    chooseOutputBtn: "Browse…",
    cancelBtn: "Cancel",
    openOutputBtn: "Open Output Folder",
    inspectingText: "Inspecting images and generating thumbnails…",
    queueCount: (n: number) => `${n} image(s)`,
    progressText: (cur: number, total: number, name: string) =>
      `Processing ${cur}/${total}: ${name}`,
    removeAria: (name: string) => `Remove ${name}`,
    resultTitle: "Batch Results",
    resultSummary: (ok: number, kept: number, skip: number, fail: number, cancelled: boolean) =>
      `${cancelled ? "Cancelled · " : ""}${ok} done${kept > 0 ? ` · ${kept} kept original` : ""}${skip > 0 ? ` · ${skip} skipped` : ""}${fail > 0 ? ` · ${fail} failed` : ""}`,
    colFile: "File",
    colStatus: "Status",
    colSize: "Original → Output",
    colDims: "Dimensions",
    colNote: "Codec / Notes",
    statusLabels: {
      ok: "Done",
      kept_original: "No Savings",
      skipped: "Skipped",
      error: "Failed",
    } as Record<BatchImageOutcomeStatus, string>,
    savedLabel: (pct: number) =>
      pct > 0 ? `-${pct.toFixed(1)}%` : pct < 0 ? `+${Math.abs(pct).toFixed(1)}%` : "0%",
    errTag: "Unreadable",
    orientTag: (o: number) => `EXIF #${o}`,
  },
};

function outcomePillClass(status: BatchImageOutcomeStatus): string {
  if (status === "ok") return "status-pill is-ok";
  if (status === "kept_original" || status === "skipped") return "status-pill is-warn";
  return "status-pill is-err";
}

export function ImageBatchShell({
  toolId,
  items,
  selectedPath,
  outputDir,
  busy,
  inspecting,
  liveProgress,
  lastReport,
  errorMessage,
  executeLabel,
  executeDisabled,
  emptyTitle,
  emptyBody,
  onAddPaths,
  onSelectPath,
  onRemovePath,
  onClear,
  onChooseOutputDir,
  onExecute,
  onCancel,
  renderPreview,
  renderControls,
  renderItemBadge,
}: ImageBatchShellProps) {
  const { locale } = useI18n();
  const t = copy[locale];
  const [dropHover, setDropHover] = useState(false);

  const selectedItem = items.find((i) => i.path === selectedPath) ?? items[0] ?? null;

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (!busy && paths.length > 0) {
              onAddPaths(paths);
            }
          },
        }),
      `img-batch-drop-${toolId}`,
    );
  }, [busy, onAddPaths, toolId]);

  const handlePickFiles = async () => {
    if (busy) return;
    const picked = await pickMultipleFiles({
      title: t.pickImagesTitle,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked.length > 0) onAddPaths(picked);
  };

  const handlePickFolders = async () => {
    if (busy) return;
    const picked = await pickMultipleDirectories({ title: t.pickFoldersTitle });
    if (picked.length > 0) onAddPaths(picked);
  };

  const handlePickOutput = async () => {
    if (busy) return;
    const picked = await pickSingleDirectory({ title: t.pickOutputTitle });
    if (picked) onChooseOutputDir(picked);
  };

  const pct =
    liveProgress && liveProgress.totalItems > 0
      ? Math.min(100, Math.round((liveProgress.currentIndex / liveProgress.totalItems) * 100))
      : 0;

  return (
    <div className={`img-batch-workspace ${dropHover ? "is-drop-hover" : ""}`}>
      {errorMessage && (
        <div className="inline-banner is-err" role="alert">
          {errorMessage}
        </div>
      )}

      {liveProgress && (
        <div className="img-batch-queue-card" role="status" aria-live="polite">
          <div className="img-batch-toolbar">
            <strong style={{ fontSize: 12.5 }}>
              {t.progressText(
                liveProgress.currentIndex,
                liveProgress.totalItems,
                liveProgress.currentFileName,
              )}
            </strong>
            <button type="button" className="btn btn-secondary" onClick={onCancel}>
              {t.cancelBtn}
            </button>
          </div>
          <div className="img-batch-progress-bar">
            <div className="img-batch-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <div className="img-batch-main-grid">
        <section className="img-batch-stage-card">
          {items.length === 0 ? (
            <div className="img-batch-empty" style={{ flex: 1 }}>
              <strong>{emptyTitle}</strong>
              <p className="img-batch-hint">{emptyBody}</p>
              <div className="img-batch-group" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || inspecting}
                  onClick={handlePickFiles}
                >
                  {t.addImages}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || inspecting}
                  onClick={handlePickFolders}
                >
                  {t.addFolders}
                </button>
              </div>
            </div>
          ) : (
            renderPreview(selectedItem)
          )}
        </section>

        <aside className="img-batch-controls-card">
          {renderControls()}

          <div
            className="img-batch-section"
            style={{ borderTop: "1px solid var(--border-subtle)", paddingTop: 10 }}
          >
            <span className="img-batch-section-title">{t.outputDirLabel}</span>
            <div
              className={`img-batch-path-box ${outputDir ? "" : "is-placeholder"}`}
              title={outputDir || undefined}
            >
              {outputDir || t.outputDirPlaceholder}
            </div>
            <div className="img-batch-group">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={handlePickOutput}
              >
                {t.chooseOutputBtn}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flex: 1 }}
                disabled={busy || items.length === 0 || !outputDir || executeDisabled}
                onClick={onExecute}
              >
                {executeLabel}
              </button>
            </div>
          </div>
        </aside>
      </div>

      <section className="img-batch-queue-card">
        <div className="img-batch-toolbar">
          <div className="img-batch-group">
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || inspecting}
              onClick={handlePickFiles}
            >
              {t.addImages}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || inspecting}
              onClick={handlePickFolders}
            >
              {t.addFolders}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || items.length === 0}
              onClick={onClear}
            >
              {t.clearList}
            </button>
          </div>
          <span className="img-batch-hint">
            {inspecting ? t.inspectingText : t.queueCount(items.length)}
          </span>
        </div>

        {items.length > 0 && (
          <div className="img-batch-strip" role="list">
            {items.map((item) => {
              const isSelected = selectedItem?.path === item.path;
              return (
                <div
                  key={item.path}
                  role="listitem"
                  className={`img-batch-item-card ${isSelected ? "is-selected" : ""}`}
                  onClick={() => onSelectPath(item.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelectPath(item.path);
                    }
                  }}
                  tabIndex={0}
                >
                  {item.thumbnailDataUrl ? (
                    <img
                      src={item.thumbnailDataUrl}
                      alt={item.fileName}
                      className="img-batch-thumb"
                    />
                  ) : (
                    <div className="img-batch-thumb-placeholder">
                      {item.error ? "!" : formatImageFormatLabel(item.format)}
                    </div>
                  )}
                  <div className="img-batch-item-meta">
                    <div className="img-batch-item-name" title={item.fileName}>
                      {item.fileName}
                    </div>
                    <div className="img-batch-item-sub">
                      {item.error ? (
                        <span style={{ color: "var(--status-err)" }}>{t.errTag}</span>
                      ) : (
                        <>
                          {formatImageFormatLabel(item.format)} · {item.displayWidth}×
                          {item.displayHeight} · {formatImageBytes(item.byteLength)}
                        </>
                      )}
                    </div>
                    <div className="img-batch-group" style={{ gap: 4 }}>
                      {item.exifOrientation > 1 && (
                        <span className="status-pill">{t.orientTag(item.exifOrientation)}</span>
                      )}
                      {item.warnings.map((w) => (
                        <span
                          key={w}
                          className="status-pill is-warn"
                          title={formatImageWarningText(w, locale)}
                        >
                          {formatImageWarningText(w, locale)}
                        </span>
                      ))}
                      {renderItemBadge?.(item)}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="img-batch-remove-btn"
                    disabled={busy}
                    aria-label={t.removeAria(item.fileName)}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemovePath(item.path);
                    }}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {lastReport && (
        <section className="img-batch-queue-card">
          <div className="img-batch-toolbar">
            <div className="img-batch-group">
              <strong style={{ fontSize: 13 }}>{t.resultTitle}</strong>
              <span className="status-pill is-ok">
                {t.resultSummary(
                  lastReport.succeededCount,
                  lastReport.keptOriginalCount,
                  lastReport.skippedCount,
                  lastReport.failedCount,
                  lastReport.cancelled,
                )}
              </span>
              {lastReport.totalOriginalBytes > 0 && lastReport.totalOutputBytes > 0 && (
                <span className="img-batch-hint">
                  {formatImageBytes(lastReport.totalOriginalBytes)} →{" "}
                  {formatImageBytes(lastReport.totalOutputBytes)}
                </span>
              )}
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => void openLocalDirectory(lastReport.outputDir)}
            >
              {t.openOutputBtn}
            </button>
          </div>

          <div className="img-batch-results-table-wrap">
            <table className="img-batch-table">
              <thead>
                <tr>
                  <th>{t.colFile}</th>
                  <th>{t.colStatus}</th>
                  <th>{t.colSize}</th>
                  <th>{t.colDims}</th>
                  <th>{t.colNote}</th>
                </tr>
              </thead>
              <tbody>
                {lastReport.items.map((row, idx) => (
                  <tr key={`${row.sourcePath}-${idx}`}>
                    <td className="img-batch-mono">{row.fileName}</td>
                    <td>
                      <span className={outcomePillClass(row.status)}>
                        {t.statusLabels[row.status]}
                      </span>
                    </td>
                    <td>
                      {row.outputBytes > 0 ? (
                        <>
                          {formatImageBytes(row.originalBytes)} →{" "}
                          <strong>{formatImageBytes(row.outputBytes)}</strong>{" "}
                          <span className="img-batch-hint">({t.savedLabel(row.savedPercent)})</span>
                        </>
                      ) : (
                        formatImageBytes(row.originalBytes)
                      )}
                    </td>
                    <td>
                      {row.outputWidth && row.outputHeight
                        ? `${row.outputWidth}×${row.outputHeight}`
                        : "—"}
                    </td>
                    <td>
                      {row.codecNote && <div>{row.codecNote}</div>}
                      {row.message && <div className="img-batch-hint">{row.message}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
