import type { Locale } from "./messages";

export interface PdfMessages {
  common: {
    openPdf: string;
    openInPreview: string;
    openFolder: string;
    chooseOutputFile: string;
    chooseOutputFolder: string;
    cancel: string;
    clear: string;
    remove: string;
    moveUp: string;
    moveDown: string;
    pagesUnit: (n: number) => string;
    bytesLabel: (bytes: number) => string;
    scannedBadge: string;
    textLayerBadge: string;
    signedBadge: string;
    acroFormBadge: string;
    oversizedBadge: string;
    pdfBadge: string;
    imageBadge: string;
    nonDestructiveNote: string;
    signatureNotice: string;
    structuralSummaryTitle: string;
    linksSummary: (ext: number, internal: number, dropped: number) => string;
    bookmarksSummary: (remapped: number, dropped: number) => string;
    dropHint: string;
    working: string;
  };
  reader: {
    title: string;
    subtitle: string;
    emptyTitle: string;
    emptyBody: string;
    prevPage: string;
    nextPage: string;
    pageInputLabel: string;
    fitWidth: string;
    fitPage: string;
    zoomOut: string;
    zoomIn: string;
    zoomReset: string;
    toggleSidebar: string;
    fullscreenEnter: string;
    fullscreenExit: string;
    searchPlaceholder: string;
    searchBtn: string;
    searchCaseSensitive: string;
    searchNoMatches: string;
    searchCount: (current: number, total: number, truncated: boolean) => string;
    searchPrev: string;
    searchNext: string;
    searchClose: string;
    tabThumbs: string;
    tabOutlines: string;
    tabInfo: string;
    noOutlines: string;
    scannedBanner: string;
    signatureBanner: string;
    openExternalConfirm: (uri: string) => string;
    sendToMerge: string;
    sendToSplit: string;
    infoFileName: string;
    infoFileSize: string;
    infoPageCount: string;
    infoTextLayer: string;
    infoTextLayerYes: string;
    infoTextLayerNo: string;
    infoSignatures: string;
    infoAcroForm: string;
    infoYes: string;
    infoNo: string;
    infoTitle: string;
    infoAuthor: string;
    infoCreator: string;
    infoProducer: string;
    pageRendering: (page: number) => string;
  };
  merge: {
    title: string;
    subtitle: string;
    addFilesBtn: string;
    addPdfOrImagesHint: string;
    emptyQueue: string;
    queueHeader: (files: number, pages: number) => string;
    optionsTitle: string;
    addFilenameBookmarks: string;
    addFilenameBookmarksHint: string;
    outputPathLabel: string;
    outputPathPlaceholder: string;
    startMergeBtn: string;
    needTwoFiles: string;
    needOutputPath: string;
    policyNote: string;
    resultTitle: string;
    resultSummary: (files: number, pages: number, bytes: string) => string;
    mixedBreakdown: (pdfs: number, images: number) => string;
    overwriteTitle: string;
    overwriteBody: (path: string) => string;
    overwriteConfirm: string;
  };
  split: {
    title: string;
    subtitle: string;
    selectSourceBtn: string;
    emptySource: string;
    modeLabel: string;
    modeEveryPage: string;
    modeEveryN: string;
    modeCustom: string;
    chunkSizeLabel: string;
    customRangesLabel: string;
    customRangesPlaceholder: string;
    customRangesHint: string;
    outputDirLabel: string;
    outputDirPlaceholder: string;
    planPreviewTitle: (files: number, pages: number) => string;
    colPart: string;
    colFileName: string;
    colPages: string;
    colCount: string;
    collisionTag: string;
    startSplitBtn: string;
    needOutputDir: string;
    resultTitle: (count: number, pages: number, bytes: string) => string;
    cancelledNotice: string;
  };
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export const PDF_MESSAGES: Record<Locale, PdfMessages> = {
  "zh-CN": {
    common: {
      openPdf: "打开 PDF…",
      openInPreview: "在内置预览中打开",
      openFolder: "打开所在目录",
      chooseOutputFile: "选择保存位置…",
      chooseOutputFolder: "选择输出文件夹…",
      cancel: "取消",
      clear: "清空",
      remove: "移除",
      moveUp: "上移",
      moveDown: "下移",
      pagesUnit: (n) => `${n} 页`,
      bytesLabel: formatByteSize,
      scannedBadge: "无文字层（扫描/图片）",
      textLayerBadge: "含可复制文字层",
      signedBadge: "含数字签名",
      acroFormBadge: "含表单",
      oversizedBadge: "超大页面",
      pdfBadge: "PDF",
      imageBadge: "图片",
      nonDestructiveNote: "离线本地处理，永不覆盖源文件；输出统一写入新文件。",
      signatureNotice:
        "检测到数字签名：任何结构编辑都会使原密码学签名失效，输出副本将移除失效签名标记。",
      structuralSummaryTitle: "结构保留摘要",
      linksSummary: (ext, internal, dropped) =>
        `外部链接保留 ${ext} · 页内链接重映射 ${internal} · 清理失效链接 ${dropped}`,
      bookmarksSummary: (remapped, dropped) =>
        `书签目录保留/重映射 ${remapped} · 清理失效书签 ${dropped}`,
      dropHint: "支持直接拖入本地文件",
      working: "正在处理…",
    },
    reader: {
      title: "PDF 快速预览",
      subtitle: "内置离线 PDF 阅读器（独立渲染进程、可复制文字层、全文搜索与书签目录）",
      emptyTitle: "打开本地 PDF 进行离线预览",
      emptyBody:
        "选择或直接拖入任意本地 PDF 文件。支持缩放、全文搜索、书签跳转、缩略图导航与中文/英文文字复制。",
      prevPage: "上一页",
      nextPage: "下一页",
      pageInputLabel: "当前页码",
      fitWidth: "适应宽度",
      fitPage: "适应整页",
      zoomOut: "缩小",
      zoomIn: "放大",
      zoomReset: "重置缩放",
      toggleSidebar: "切换左侧栏",
      fullscreenEnter: "全屏阅读",
      fullscreenExit: "退出全屏",
      searchPlaceholder: "查找文档文字 (Ctrl+F)…",
      searchBtn: "查找",
      searchCaseSensitive: "区分大小写",
      searchNoMatches: "未找到匹配项",
      searchCount: (cur, total, truncated) => `${cur} / ${total}${truncated ? "+" : ""}`,
      searchPrev: "上一个",
      searchNext: "下一个",
      searchClose: "关闭查找",
      tabThumbs: "缩略图",
      tabOutlines: "目录",
      tabInfo: "信息",
      noOutlines: "此文档未包含书签目录。",
      scannedBanner:
        "此 PDF 看起来是扫描件或纯图片页面，不包含可选择/可搜索的文字层（本工具不执行 OCR 识别）。",
      signatureBanner:
        "此 PDF 包含数字签名。内置预览为只读模式，不会修改原文件；若将其送入编辑工具导出副本，原签名将失效。",
      openExternalConfirm: (uri) => `确定要在系统默认浏览器中打开外部链接吗？\n\n${uri}`,
      sendToMerge: "发送到合并 (P07)",
      sendToSplit: "发送到拆分 (P08)",
      infoFileName: "文件名",
      infoFileSize: "文件大小",
      infoPageCount: "总页数",
      infoTextLayer: "文字层",
      infoTextLayerYes: "可选择与搜索",
      infoTextLayerNo: "未检测到（扫描/纯图）",
      infoSignatures: "数字签名",
      infoAcroForm: "交互表单",
      infoYes: "是",
      infoNo: "否",
      infoTitle: "标题",
      infoAuthor: "作者",
      infoCreator: "创建程序",
      infoProducer: "生成器",
      pageRendering: (p) => `正在渲染第 ${p} 页…`,
    },
    merge: {
      title: "PDF 合并",
      subtitle: "按顺序无损合并多个 PDF（支持混入图片自动转页），保留矢量、文字层、链接与书签目录",
      addFilesBtn: "添加 PDF / 图片…",
      addPdfOrImagesHint: "支持 .pdf 以及 .png / .jpg / .webp / .bmp / .tif / .heic",
      emptyQueue: "添加或拖入至少 2 个 PDF（或混入图片）以开始合并。可拖拽排序或上下调整顺序。",
      queueHeader: (files, pages) => `已添加 ${files} 个文件 · 共 ${pages} 页`,
      optionsTitle: "合并选项与输出",
      addFilenameBookmarks: "为每个源文件添加顶层书签目录",
      addFilenameBookmarksHint: "按文件名创建一级目录，并将源文件原有书签自动归入其下。",
      outputPathLabel: "输出新 PDF 路径",
      outputPathPlaceholder: "点击右侧按钮选择合并后保存的新 PDF 路径…",
      startMergeBtn: "合并为新 PDF",
      needTwoFiles: "请至少添加 2 个文件后再执行合并。",
      needOutputPath: "请先选择输出 PDF 文件路径。",
      policyNote:
        "矢量与可复制文字层保持原样；外部链接与有效页内跳转自动保留重映射；若源文件含交互表单或数字签名，输出副本仅保留页面视觉外观且原签名失效。",
      resultTitle: "合并完成",
      resultSummary: (files, pages, bytes) => `已合并 ${files} 个文件，共 ${pages} 页（${bytes}）`,
      mixedBreakdown: (pdfs, images) => `来源构成：${pdfs} 个 PDF + ${images} 张图片`,
      overwriteTitle: "目标文件已存在",
      overwriteBody: (p) => `目标位置已存在文件「${p}」。是否替换该文件？（源文件绝不会被覆盖）`,
      overwriteConfirm: "确认替换",
    },
    split: {
      title: "PDF 拆分",
      subtitle: "按逐页、每 N 页或自定义页码范围拆分 PDF，执行前实时校验并预览全部输出文件名",
      selectSourceBtn: "选择要拆分的 PDF…",
      emptySource: "选择或拖入 1 个本地 PDF 文件。支持逐页拆分、每 N 页分卷及自定义范围。",
      modeLabel: "拆分模式",
      modeEveryPage: "逐页拆分",
      modeEveryN: "每 N 页拆分",
      modeCustom: "自定义页码范围",
      chunkSizeLabel: "每个文件页数 (N)",
      customRangesLabel: "页码范围（每行或用分号 ; 分隔一个输出文件）",
      customRangesPlaceholder: "例如：\n1-3\n4-6\n7, 9-10",
      customRangesHint:
        "同一输出文件内用逗号分隔页码（如 1-3, 5）；不同输出文件用分号 ; 或换行分隔。",
      outputDirLabel: "输出目录（自动防覆盖命名）",
      outputDirPlaceholder: "点击右侧按钮选择拆分结果保存目录…",
      planPreviewTitle: (files, pages) => `拆分计划预览：将生成 ${files} 个 PDF · 共 ${pages} 页`,
      colPart: "序号",
      colFileName: "输出文件名",
      colPages: "包含页码",
      colCount: "页数",
      collisionTag: "自动防重名",
      startSplitBtn: "开始拆分",
      needOutputDir: "请先选择输出文件夹。",
      resultTitle: (count, pages, bytes) =>
        `拆分完成：已生成 ${count} 个 PDF，共 ${pages} 页（总计 ${bytes}）`,
      cancelledNotice: "任务已取消，已保留取消前完成提交的文件并清理未完成临时文件。",
    },
  },
  "en-US": {
    common: {
      openPdf: "Open PDF…",
      openInPreview: "Open in Preview",
      openFolder: "Open Folder",
      chooseOutputFile: "Save As…",
      chooseOutputFolder: "Choose Folder…",
      cancel: "Cancel",
      clear: "Clear",
      remove: "Remove",
      moveUp: "Move Up",
      moveDown: "Move Down",
      pagesUnit: (n) => `${n} ${n === 1 ? "page" : "pages"}`,
      bytesLabel: formatByteSize,
      scannedBadge: "No text layer (scanned/image)",
      textLayerBadge: "Selectable text",
      signedBadge: "Digitally signed",
      acroFormBadge: "AcroForm",
      oversizedBadge: "Oversized page",
      pdfBadge: "PDF",
      imageBadge: "Image",
      nonDestructiveNote: "100% local & offline. Source files are never overwritten.",
      signatureNotice:
        "Digital signatures detected: structural edits invalidate original cryptographic signatures and strip invalid signature markers from edited outputs.",
      structuralSummaryTitle: "Structural Preservation Summary",
      linksSummary: (ext, internal, dropped) =>
        `External links kept: ${ext} · Internal links remapped: ${internal} · Dangling links removed: ${dropped}`,
      bookmarksSummary: (remapped, dropped) =>
        `Bookmarks remapped: ${remapped} · Dangling bookmarks pruned: ${dropped}`,
      dropHint: "Drag and drop local files here",
      working: "Working…",
    },
    reader: {
      title: "PDF Quick Preview",
      subtitle:
        "Built-in offline PDF reader (isolated render worker, selectable text layer, full-text search & outlines)",
      emptyTitle: "Open a Local PDF for Offline Preview",
      emptyBody:
        "Choose or drag a local PDF here. Supports zoom, full-text search, bookmark outlines, thumbnails, and selecting/copying text.",
      prevPage: "Previous page",
      nextPage: "Next page",
      pageInputLabel: "Current page",
      fitWidth: "Fit Width",
      fitPage: "Fit Page",
      zoomOut: "Zoom out",
      zoomIn: "Zoom in",
      zoomReset: "Reset zoom",
      toggleSidebar: "Toggle sidebar",
      fullscreenEnter: "Fullscreen",
      fullscreenExit: "Exit fullscreen",
      searchPlaceholder: "Find in document (Ctrl+F)…",
      searchBtn: "Find",
      searchCaseSensitive: "Match case",
      searchNoMatches: "No matches found",
      searchCount: (cur, total, truncated) => `${cur} / ${total}${truncated ? "+" : ""}`,
      searchPrev: "Previous match",
      searchNext: "Next match",
      searchClose: "Close search",
      tabThumbs: "Thumbnails",
      tabOutlines: "Outlines",
      tabInfo: "Info",
      noOutlines: "This document has no bookmark outlines.",
      scannedBanner:
        "This PDF appears to be scanned or image-only with no selectable/searchable text layer (OCR is not performed).",
      signatureBanner:
        "This PDF contains digital signatures. Preview is strictly read-only; structural edits in other tools will invalidate original signatures.",
      openExternalConfirm: (uri) => `Open external link in your default browser?\n\n${uri}`,
      sendToMerge: "Send to Merge (P07)",
      sendToSplit: "Send to Split (P08)",
      infoFileName: "File Name",
      infoFileSize: "File Size",
      infoPageCount: "Pages",
      infoTextLayer: "Text Layer",
      infoTextLayerYes: "Selectable & searchable",
      infoTextLayerNo: "Not detected (scanned/image)",
      infoSignatures: "Digital Signatures",
      infoAcroForm: "AcroForm",
      infoYes: "Yes",
      infoNo: "No",
      infoTitle: "Title",
      infoAuthor: "Author",
      infoCreator: "Creator",
      infoProducer: "Producer",
      pageRendering: (p) => `Rendering page ${p}…`,
    },
    merge: {
      title: "Merge PDFs",
      subtitle:
        "Losslessly merge multiple PDFs (and mixed images) in order while preserving vectors, text layers, links, and outlines",
      addFilesBtn: "Add PDFs / Images…",
      addPdfOrImagesHint: "Supports .pdf plus .png / .jpg / .webp / .bmp / .tif / .heic",
      emptyQueue:
        "Add or drop at least 2 PDFs (or mixed images) to merge. Drag rows or use buttons to reorder.",
      queueHeader: (files, pages) => `${files} files queued · ${pages} total pages`,
      optionsTitle: "Merge Options & Output",
      addFilenameBookmarks: "Add top-level bookmark per source file",
      addFilenameBookmarksHint:
        "Creates a top-level outline entry for each source filename and nests its existing outlines underneath.",
      outputPathLabel: "Output PDF Path",
      outputPathPlaceholder: "Choose where to save the merged PDF…",
      startMergeBtn: "Merge to New PDF",
      needTwoFiles: "Add at least 2 files before merging.",
      needOutputPath: "Choose an output PDF file path first.",
      policyNote:
        "Vectors and selectable text layers are preserved intact. External URI links and surviving internal links/outlines are remapped cleanly. Interactive form trees are simplified and original digital signatures are invalidated on merged copies.",
      resultTitle: "Merge Complete",
      resultSummary: (files, pages, bytes) =>
        `Merged ${files} files into ${pages} pages (${bytes})`,
      mixedBreakdown: (pdfs, images) => `Sources: ${pdfs} PDF(s) + ${images} image(s)`,
      overwriteTitle: "Destination Exists",
      overwriteBody: (p) =>
        `"${p}" already exists. Replace this file? (Source inputs can never be overwritten.)`,
      overwriteConfirm: "Replace File",
    },
    split: {
      title: "Split PDF",
      subtitle:
        "Split by every page, every N pages, or custom page ranges with upfront validation and output filename preview",
      selectSourceBtn: "Select PDF to Split…",
      emptySource:
        "Select or drop a local PDF file to split per page, every N pages, or by custom ranges.",
      modeLabel: "Split Mode",
      modeEveryPage: "Every Page",
      modeEveryN: "Every N Pages",
      modeCustom: "Custom Ranges",
      chunkSizeLabel: "Pages per file (N)",
      customRangesLabel: "Page ranges (separate output files by ';' or new lines)",
      customRangesPlaceholder: "Example:\n1-3\n4-6\n7, 9-10",
      customRangesHint:
        "Use commas within one output file (e.g. 1-3, 5); use semicolons ';' or new lines to separate output files.",
      outputDirLabel: "Output Folder (collision-safe, never overwrites)",
      outputDirPlaceholder: "Choose an output directory for split PDFs…",
      planPreviewTitle: (files, pages) =>
        `Split Plan Preview: ${files} output PDF(s) · ${pages} total pages`,
      colPart: "#",
      colFileName: "Output Filename",
      colPages: "Pages",
      colCount: "Count",
      collisionTag: "Renamed",
      startSplitBtn: "Split PDF",
      needOutputDir: "Choose an output folder first.",
      resultTitle: (count, pages, bytes) =>
        `Split Complete: ${count} PDF(s), ${pages} pages (${bytes} total)`,
      cancelledNotice:
        "Operation cancelled. Already finalized files were kept and unfinished temp files were removed.",
    },
  },
};
