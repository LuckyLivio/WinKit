import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FileDown,
  FileText,
  FolderOpen,
  Info,
  Save,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { usePdfSession } from "../../lib/pdfSessionStore";
import {
  bindDisposableListener,
  cancelBackendTask,
  exportMarkdownToPdf,
  formatLocalizedError,
  openLocalDirectory,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  readLocalTextFile,
  renderMarkdownPreview,
  subscribeFileDrop,
  subscribePdfTaskProgress,
  suggestSafeSiblingPath,
  type MarkdownMarginPreset,
  type MarkdownPaperSize,
  type MarkdownPreviewResult,
  type MarkdownTheme,
} from "../../lib/tauriBridge";
import "../pdf-encrypt/pdfCrypto.css";
import "./pdfMarkdown.css";

const SAMPLE_MARKDOWN_ZH = `# WinKit 离线 Markdown 文档示例

本文档展示 **中英文混排**、表格、引用、嵌套列表、任务清单、长代码自动换行，以及 [可点击外部链接](https://example.com/winkit)。

## 一、核心特性

| 能力 | 状态 | 说明 |
| :--- | :---: | :--- |
| 离线排版 | 支持 | 不联网加载外部脚本或远程图片 |
| 目录书签 | 支持 | 自动依据 H1–H3 标题生成 PDF 书签 |
| 文字层 | 支持 | 保留可选中文字与可点击链接 |

> 安全边界：默认转义原始 HTML 标签，仅允许内联与当前 Markdown 文件位于同一目录内的相对路径图片。

### 1.1 任务与嵌套列表

- [x] 本地 AST 解析与安全过滤
- [x] A4 / Letter 纸张与页眉页脚页码
  - 支持简约排版与 GitHub 文档两套主题
  - 长代码块自动折行不裁切

\`\`\`ts
export function formatReportLine(project: string, status: string): string {
  return \`[\${project}] offline-vector-pdf-export-status=\${status} — 超长中英文代码行会自动换行而不会超出纸张右边界\`;
}
\`\`\`

---

## 二、后续 PDF 工作流

导出完成后可直接送入 **内置预览 (C08)**、**页面裁剪 (P13)**、**可视化签名 (P06)**、**PDF 水印 (I13)**、**PDF 压缩 (P14)** 或 **PDF 加密 (P15)**。
`;

const SAMPLE_MARKDOWN_EN = `# WinKit Offline Markdown Document

This sample demonstrates **bilingual typography**, GFM tables, blockquotes, nested task lists, wrapped code blocks, and [clickable external links](https://example.com/winkit).

## 1. Key Capabilities

| Feature | Status | Details |
| :--- | :---: | :--- |
| Offline export | Supported | No scripts executed and no remote images auto-fetched |
| PDF bookmarks | Supported | Generated automatically from H1–H3 headings |
| Selectable text | Supported | Preserves vector text and clickable URI links |

> Security boundary: raw HTML is escaped by default; only relative local images inside the opened Markdown file's directory are embedded.

- [x] Sanitized AST preview & PDF rendering
- [x] A4 / Letter paper sizes with running headers, footers & page numbers
  - Clean and GitHub themes
  - Automatic wrapping for long code lines

\`\`\`ts
export const longCodeWrappingCheck = "WinKit offline Markdown to PDF wraps long identifiers cleanly without clipping off the right page margin";
\`\`\`
`;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function parentDirectoryOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf("\\"), filePath.lastIndexOf("/"));
  return idx > 0 ? filePath.slice(0, idx) : filePath;
}

export function PdfMarkdownWorkspace() {
  const { locale, t } = useI18n();
  const isZh = locale === "zh-CN";
  const { pdfSession, updateMarkdownSession, openInPdfReader, sendPdfToTool } = usePdfSession();
  const state = pdfSession.markdown;

  const [preview, setPreview] = useState<MarkdownPreviewResult | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [overwriteDialogOpen, setOverwriteDialogOpen] = useState(false);
  const pendingOverwritePathRef = useRef<string | null>(null);
  const previewGenRef = useRef(0);

  // Seed default helpful sample if workspace starts empty
  useEffect(() => {
    if (!state.markdown && !state.sourceFilePath) {
      updateMarkdownSession((prev) => ({
        ...prev,
        markdown: isZh ? SAMPLE_MARKDOWN_ZH : SAMPLE_MARKDOWN_EN,
      }));
    }
  }, [isZh, state.markdown, state.sourceFilePath, updateMarkdownSession]);

  // Debounced safe preview generation through the exact same Rust pulldown-cmark sanitizer
  useEffect(() => {
    const gen = ++previewGenRef.current;
    const timer = setTimeout(() => {
      setPreviewLoading(true);
      void renderMarkdownPreview({
        markdown: state.markdown,
        sourceDir: state.sourceDir,
        theme: state.theme,
        paperSize: state.paperSize,
        marginPreset: state.marginPreset,
        headerText: state.headerText,
        footerText: state.footerText,
        showPageNumbers: state.showPageNumbers,
        locale,
      })
        .then((res) => {
          if (previewGenRef.current === gen) {
            setPreview(res);
          }
        })
        .catch(() => {
          // Keep last valid preview if backend is unavailable in browser-only unit tests
        })
        .finally(() => {
          if (previewGenRef.current === gen) {
            setPreviewLoading(false);
          }
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [
    state.markdown,
    state.sourceDir,
    state.theme,
    state.paperSize,
    state.marginPreset,
    state.headerText,
    state.footerText,
    state.showPageNumbers,
    locale,
  ]);

  const loadMarkdownFile = useCallback(
    async (filePath: string) => {
      try {
        const payload = await readLocalTextFile(filePath);
        const dir = parentDirectoryOf(payload.path);
        const suggested =
          (await suggestSafeSiblingPath(payload.path, "", "pdf").catch(() => null)) ??
          payload.path.replace(/\.(md|markdown|txt)$/i, ".pdf");
        updateMarkdownSession((prev) => ({
          ...prev,
          sourceFilePath: payload.path,
          sourceDir: dir,
          markdown: payload.content,
          outputPath: suggested,
          lastResult: null,
          errorMessage: null,
        }));
      } catch (err) {
        updateMarkdownSession((prev) => ({
          ...prev,
          errorMessage: formatLocalizedError(err, t),
        }));
      }
    },
    [t, updateMarkdownSession],
  );

  // Drag-and-drop .md files
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            const md = paths.find((p) => /\.(md|markdown|txt)$/i.test(p)) ?? paths[0];
            if (md) void loadMarkdownFile(md);
          },
        }),
      "p23-drop",
    );
  }, [loadMarkdownFile]);

  // Progress subscription
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribePdfTaskProgress((ev) => {
          if (ev.toolId !== "P23") return;
          updateMarkdownSession((prev) =>
            prev.activeTaskId && ev.taskId === prev.activeTaskId ? { ...prev, progress: ev } : prev,
          );
        }),
      "p23-progress",
    );
  }, [updateMarkdownSession]);

  const handleOpenMarkdown = async () => {
    const picked = await pickSingleFile({
      title: isZh ? "打开本地 Markdown 文件" : "Open Local Markdown File",
      filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
    });
    if (picked) {
      await loadMarkdownFile(picked);
    }
  };

  const handleBrowseOutput = async () => {
    const picked = await pickSaveFilePath({
      title: isZh ? "导出 PDF 保存位置" : "Export PDF As",
      defaultPath: state.outputPath || "document.pdf",
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (picked) {
      updateMarkdownSession((prev) => ({ ...prev, outputPath: picked }));
    }
  };

  const executeExport = async (targetPath: string, overwrite: boolean) => {
    const taskId = `p23-${Date.now()}`;
    updateMarkdownSession((prev) => ({
      ...prev,
      taskStatus: "running",
      activeTaskId: taskId,
      progress: {
        taskId,
        toolId: "P23",
        current: 5,
        total: 100,
        percent: 5,
        detail: isZh ? "正在解析与排版..." : "Sanitizing and rendering PDF...",
      },
      lastResult: null,
      errorMessage: null,
    }));

    try {
      const result = await exportMarkdownToPdf(taskId, {
        markdown: state.markdown,
        sourceDir: state.sourceDir,
        outputPath: targetPath,
        overwrite,
        theme: state.theme,
        paperSize: state.paperSize,
        marginPreset: state.marginPreset,
        headerText: state.headerText,
        footerText: state.footerText,
        showPageNumbers: state.showPageNumbers,
        includeBookmarks: state.includeBookmarks,
        locale,
      });
      updateMarkdownSession((prev) => ({
        ...prev,
        outputPath: result.outputPath,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        lastResult: result,
        errorMessage: null,
      }));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        pendingOverwritePathRef.current = targetPath;
        setOverwriteDialogOpen(true);
        updateMarkdownSession((prev) => ({
          ...prev,
          taskStatus: "idle",
          activeTaskId: null,
          progress: null,
        }));
        return;
      }
      updateMarkdownSession((prev) => ({
        ...prev,
        taskStatus: "idle",
        activeTaskId: null,
        progress: null,
        errorMessage: formatLocalizedError(err, t),
      }));
    }
  };

  const handleRunExport = async () => {
    if (!state.markdown.trim()) return;
    let target = state.outputPath.trim();
    if (!target) {
      const picked = await pickSaveFilePath({
        title: isZh ? "导出 PDF 保存位置" : "Export PDF As",
        defaultPath: state.sourceFilePath
          ? state.sourceFilePath.replace(/\.(md|markdown|txt)$/i, ".pdf")
          : "markdown_export.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!picked) return;
      target = picked;
      updateMarkdownSession((prev) => ({ ...prev, outputPath: picked }));
    }
    await executeExport(target, false);
  };

  const handleCancel = async () => {
    if (state.activeTaskId) {
      await cancelBackendTask(state.activeTaskId);
    }
  };

  return (
    <div className="pdf-md-shell">
      <div className="pdf-md-toolbar">
        <div className="pdf-md-toolbar-group">
          <button
            type="button"
            className="btn"
            disabled={state.taskStatus === "running"}
            onClick={() => void handleOpenMarkdown()}
          >
            <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "打开 .md 文件…" : "Open .md…"}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={state.taskStatus === "running"}
            onClick={() =>
              updateMarkdownSession((prev) => ({
                ...prev,
                sourceFilePath: null,
                sourceDir: null,
                markdown: isZh ? SAMPLE_MARKDOWN_ZH : SAMPLE_MARKDOWN_EN,
                errorMessage: null,
              }))
            }
          >
            <FileText size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "载入示例文档" : "Load Sample"}</span>
          </button>
          {state.sourceFilePath && (
            <span className="pdf-crypto-pill mono" title={state.sourceFilePath}>
              {state.sourceFilePath.split(/[\\/]/).pop()}
            </span>
          )}
        </div>

        <div className="pdf-md-toolbar-group">
          <span className="pdf-crypto-pill is-ok">
            <ShieldCheck size={12} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh
                ? "离线安全模式：禁用脚本与外链图片自动请求"
                : "Offline safe: no scripts or remote image fetches"}
            </span>
          </span>
        </div>
      </div>

      <div className="pdf-md-options-bar">
        <label className="pdf-md-opt">
          <span>{isZh ? "主题" : "Theme"}</span>
          <select
            aria-label={isZh ? "排版主题" : "Theme"}
            className="select"
            value={state.theme}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, theme: e.target.value as MarkdownTheme }))
            }
            disabled={state.taskStatus === "running"}
          >
            <option value="github">{isZh ? "GitHub 文档" : "GitHub"}</option>
            <option value="clean">{isZh ? "简约排版" : "Clean"}</option>
          </select>
        </label>

        <label className="pdf-md-opt">
          <span>{isZh ? "纸张" : "Paper"}</span>
          <select
            aria-label={isZh ? "纸张尺寸" : "Paper Size"}
            className="select"
            value={state.paperSize}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({
                ...prev,
                paperSize: e.target.value as MarkdownPaperSize,
              }))
            }
            disabled={state.taskStatus === "running"}
          >
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
        </label>

        <label className="pdf-md-opt">
          <span>{isZh ? "页边距" : "Margins"}</span>
          <select
            aria-label={isZh ? "页边距" : "Margins"}
            className="select"
            value={state.marginPreset}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({
                ...prev,
                marginPreset: e.target.value as MarkdownMarginPreset,
              }))
            }
            disabled={state.taskStatus === "running"}
          >
            <option value="narrow">{isZh ? "窄 (14mm)" : "Narrow (14mm)"}</option>
            <option value="normal">{isZh ? "标准 (20mm)" : "Normal (20mm)"}</option>
            <option value="wide">{isZh ? "宽 (26mm)" : "Wide (26mm)"}</option>
          </select>
        </label>

        <label className="pdf-md-opt">
          <span>{isZh ? "页眉" : "Header"}</span>
          <input
            type="text"
            className="input"
            placeholder={isZh ? "可选页眉文字" : "Optional header"}
            value={state.headerText}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, headerText: e.target.value }))
            }
            disabled={state.taskStatus === "running"}
          />
        </label>

        <label className="pdf-md-opt">
          <span>{isZh ? "页脚" : "Footer"}</span>
          <input
            type="text"
            className="input"
            placeholder={isZh ? "可选页脚文字" : "Optional footer"}
            value={state.footerText}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, footerText: e.target.value }))
            }
            disabled={state.taskStatus === "running"}
          />
        </label>

        <label className="pdf-crypto-checkbox">
          <input
            type="checkbox"
            checked={state.showPageNumbers}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, showPageNumbers: e.target.checked }))
            }
            disabled={state.taskStatus === "running"}
          />
          <span>{isZh ? "显示页码" : "Page numbers"}</span>
        </label>

        <label className="pdf-crypto-checkbox">
          <input
            type="checkbox"
            checked={state.includeBookmarks}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, includeBookmarks: e.target.checked }))
            }
            disabled={state.taskStatus === "running"}
          />
          <span>{isZh ? "生成标题书签" : "Heading bookmarks"}</span>
        </label>
      </div>

      <div className={`pdf-md-split ${dropHover ? "is-hover" : ""}`}>
        <section className="pdf-md-pane">
          <div className="pdf-md-pane-head">
            <span>{isZh ? "Markdown 编辑器" : "Markdown Editor"}</span>
            <span className="pdf-md-pane-meta mono">
              {state.markdown.length} {isZh ? "字符" : "chars"}
              {preview ? ` · ${preview.headings.length} ${isZh ? "标题" : "headings"}` : ""}
            </span>
          </div>
          <textarea
            aria-label={isZh ? "Markdown 内容" : "Markdown Content"}
            className="pdf-md-textarea"
            value={state.markdown}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, markdown: e.target.value }))
            }
            placeholder={
              isZh
                ? "在此输入或粘贴 Markdown，或直接拖入本地 .md 文件..."
                : "Write or paste Markdown here, or drop a local .md file..."
            }
            disabled={state.taskStatus === "running"}
          />
        </section>

        <section className="pdf-md-pane">
          <div className="pdf-md-pane-head">
            <span>
              {isZh ? "安全实时预览（已禁用脚本）" : "Sanitized Live Preview (No Scripts)"}
            </span>
            <span className="pdf-md-pane-meta">
              {previewLoading
                ? isZh
                  ? "更新中..."
                  : "Updating..."
                : preview &&
                    (preview.blockedRemoteImages > 0 ||
                      preview.blockedLocalImages > 0 ||
                      preview.strippedRawHtmlCount > 0)
                  ? isZh
                    ? `拦截外链图 ${preview.blockedRemoteImages} · 拦截越权图 ${preview.blockedLocalImages} · 转义 HTML ${preview.strippedRawHtmlCount}`
                    : `Blocked remote ${preview.blockedRemoteImages} · Blocked local ${preview.blockedLocalImages} · Escaped HTML ${preview.strippedRawHtmlCount}`
                  : isZh
                    ? "已内联本地相对图片" + (preview ? ` ${preview.embeddedLocalImages} 张` : "")
                    : `Embedded local images: ${preview?.embeddedLocalImages ?? 0}`}
            </span>
          </div>
          <iframe
            title={isZh ? "Markdown 排版预览" : "Markdown Preview"}
            className="pdf-md-preview-frame"
            sandbox=""
            srcDoc={preview?.htmlDocument ?? ""}
          />
        </section>
      </div>

      {state.errorMessage && (
        <div className="pdf-banner pdf-banner-error" role="alert">
          <AlertTriangle size={15} strokeWidth={1.75} aria-hidden="true" />
          <span>{state.errorMessage}</span>
        </div>
      )}

      {state.taskStatus === "running" && state.progress && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
            <span>{state.progress.detail}</span>
            <span className="mono">{Math.round(state.progress.percent)}%</span>
          </div>
          <progress value={state.progress.percent} max={100} style={{ width: "100%" }} />
        </div>
      )}

      <div className="pdf-md-footer">
        <div className="pdf-crypto-output-row" style={{ flex: 1, minWidth: 260 }}>
          <input
            aria-label={isZh ? "导出 PDF 路径" : "Export PDF Path"}
            type="text"
            className="input mono"
            value={state.outputPath}
            onChange={(e) =>
              updateMarkdownSession((prev) => ({ ...prev, outputPath: e.target.value }))
            }
            placeholder={isZh ? "选择导出 PDF 路径（或点击导出后选择）" : "Choose output .pdf path"}
            disabled={state.taskStatus === "running"}
          />
          <button
            type="button"
            className="btn"
            onClick={() => void handleBrowseOutput()}
            disabled={state.taskStatus === "running"}
          >
            <Save size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{isZh ? "另存为…" : "Save As…"}</span>
          </button>
        </div>

        <div className="pdf-md-toolbar-group">
          {state.taskStatus === "running" ? (
            <button type="button" className="btn" onClick={() => void handleCancel()}>
              <XCircle size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "取消导出" : "Cancel"}</span>
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary"
              disabled={!state.markdown.trim()}
              onClick={() => void handleRunExport()}
            >
              <FileDown size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "导出矢量 PDF" : "Export Vector PDF"}</span>
            </button>
          )}
        </div>
      </div>

      {state.lastResult && (
        <section className="pdf-crypto-result" role="status">
          <div className="pdf-crypto-result-header">
            <CheckCircle2 size={16} strokeWidth={1.75} aria-hidden="true" />
            <span>
              {isZh
                ? `导出完成：共 ${state.lastResult.pageCount} 页 · ${formatBytes(state.lastResult.byteLength)} · ${state.lastResult.bookmarkCount} 条标题书签`
                : `Exported: ${state.lastResult.pageCount} pages · ${formatBytes(state.lastResult.byteLength)} · ${state.lastResult.bookmarkCount} bookmarks`}
            </span>
          </div>
          <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-all" }}>
            {state.lastResult.outputPath}
          </div>
          {(state.lastResult.blockedRemoteImages > 0 ||
            state.lastResult.blockedLocalImages > 0 ||
            state.lastResult.strippedRawHtmlCount > 0) && (
            <div className="pdf-crypto-disclosure">
              <Info size={14} strokeWidth={1.75} style={{ flexShrink: 0, marginTop: 2 }} />
              <span>
                {isZh
                  ? `离线安全过滤摘要：已内联本地图片 ${state.lastResult.embeddedLocalImages} 张，拦截远程图片 ${state.lastResult.blockedRemoteImages} 张，拦截目录外图片 ${state.lastResult.blockedLocalImages} 张，转义原始 HTML ${state.lastResult.strippedRawHtmlCount} 处。`
                  : `Offline sanitizer summary: embedded ${state.lastResult.embeddedLocalImages} local image(s), blocked ${state.lastResult.blockedRemoteImages} remote image(s), blocked ${state.lastResult.blockedLocalImages} out-of-folder image(s), escaped ${state.lastResult.strippedRawHtmlCount} raw HTML fragment(s).`}
              </span>
            </div>
          )}
          <div className="pdf-crypto-result-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => openInPdfReader(state.lastResult!.outputPath)}
            >
              <BookOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "在内置预览 (C08) 中打开" : "Open in PDF Preview (C08)"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(state.lastResult!.outputPath, "P13")}
            >
              <span>{isZh ? "送至 P13 裁剪" : "Send to Crop (P13)"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => sendPdfToTool(state.lastResult!.outputPath, "P06")}
            >
              <span>{isZh ? "送至 P06 签名" : "Send to Sign (P06)"}</span>
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void openLocalDirectory(parentDirectoryOf(state.lastResult!.outputPath))
              }
            >
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{isZh ? "打开所在文件夹" : "Open Folder"}</span>
            </button>
          </div>
        </section>
      )}

      <ConfirmDialog
        open={overwriteDialogOpen}
        title={isZh ? "目标文件已存在" : "Target File Already Exists"}
        body={
          isZh
            ? `目标路径已存在文件：\n${pendingOverwritePathRef.current ?? ""}\n是否确认覆盖？`
            : `A file already exists at:\n${pendingOverwritePathRef.current ?? ""}\nOverwrite it?`
        }
        confirmLabel={isZh ? "确认覆盖" : "Overwrite"}
        cancelLabel={isZh ? "取消" : "Cancel"}
        onCancel={() => {
          setOverwriteDialogOpen(false);
          pendingOverwritePathRef.current = null;
        }}
        onConfirm={() => {
          const target = pendingOverwritePathRef.current;
          setOverwriteDialogOpen(false);
          pendingOverwritePathRef.current = null;
          if (target) {
            void executeExport(target, true);
          }
        }}
      />
    </div>
  );
}
