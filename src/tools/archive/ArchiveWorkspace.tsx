import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  formatLocalizedError,
  inspectArchive,
  openLocalDirectory,
  pickMultipleDirectories,
  pickMultipleFiles,
  pickSaveFilePath,
  pickSingleDirectory,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import {
  ARCHIVE_FILE_DIALOG_EXTENSIONS,
  ARCHIVE_SUPPORT_MATRIX,
  createFormatRequiresPassword,
  extractBaseFileName,
  formatArchiveBytes,
  formatArchiveFormatLabel,
  getCreateExtension,
  suggestCreateOutputFilename,
  type ArchiveCreateFormat,
  type ArchiveExtractStatus,
  type ExtractConflictPolicy,
} from "./archiveModel";
import "./archiveWorkspace.css";

const copy = {
  "zh-CN": {
    tabExtract: "解压压缩包",
    tabCreate: "创建压缩包",
    matrixSummary: "查看离线支持格式对照表（预览 / 解压 / 创建 / 密码）",
    matrixColFormat: "格式",
    matrixColExt: "扩展名",
    matrixColPreview: "预览列表",
    matrixColExtract: "解压",
    matrixColCreate: "创建",
    matrixColPassword: "密码 / 说明",
    yes: "支持",
    no: "—",
    addArchivesBtn: "添加压缩包",
    clearArchivesBtn: "清空列表",
    pickArchivesTitle: "选择一个或多个压缩包",
    dropExtractHint:
      "支持从资源管理器一次拖入多个压缩包（ZIP、7z、RAR、TAR、TAR.GZ/XZ/BZ2、单文件 GZ/XZ/BZ2、ISO）。每个包都会解压到独立目录，同名压缩包也不会混写。",
    emptyExtractTitle: "尚未添加压缩包",
    emptyExtractBody:
      "点击“添加压缩包”或直接拖入一个或多个压缩包即可先预览内部文件列表、路径和大小。",
    inspectingLabel: "正在读取压缩包列表…",
    encryptedBadge: "需要密码",
    entriesCount: (n: number) => `${n} 项`,
    pwdPlaceholder: "输入密码（仅本次内存使用）",
    unlockPreviewBtn: "解锁预览",
    showPwd: "显示",
    hidePwd: "隐藏",
    removeAria: (name: string) => `移除 ${name}`,
    previewHeading: (name: string) => `内容预览：${name}`,
    previewSelectHint: "在左侧选择一个压缩包以查看内部文件列表、路径和大小。",
    previewSummary: (count: number, size: string, truncated: boolean) =>
      truncated
        ? `共 ${count} 项（已截断展示前 5,000 项）· 解压后预计 ${size}`
        : `共 ${count} 项 · 解压后预计 ${size}`,
    colPath: "路径",
    colType: "类型",
    colSize: "原始大小",
    colCompressed: "压缩后",
    typeDir: "目录",
    typeFile: "文件",
    typeSymlink: "符号链接（解压跳过）",
    typeMacos: "macOS 辅助项",
    lockedTag: "加密",
    outputDirLabel: "输出目录",
    outputDirPlaceholder: "请选择解压输出目录（每个压缩包将在其下建立独立目录）",
    chooseOutputDirBtn: "选择输出目录…",
    pickOutputDirTitle: "选择解压输出父目录",
    conflictPolicyLabel: "同名目录策略",
    conflictUnique: "自动建立独立子目录（如 pack (2)）",
    conflictFail: "目标目录已存在时保护跳过",
    skipMacosLabel: "跳过 .DS_Store 与 __MACOSX 辅助文件",
    startExtractBtn: (n: number) => (n > 1 ? `开始批量解压 (${n} 个)` : "开始解压"),
    retryFailedBtn: (n: number) => `重试密码/失败项 (${n})`,
    cancelTaskBtn: "取消任务",
    openOutputDirBtn: "打开输出目录",
    openParentDirBtn: "打开父目录",
    extractProgressTitle: (cur: number, total: number, bytes: string) =>
      `正在解压第 ${cur}/${total} 个压缩包 · 已写入 ${bytes}`,
    createProgressTitle: (cur: number, total: number, bytes: string) =>
      `正在压缩第 ${cur}/${total} 项 · 已处理 ${bytes}`,
    reportHeading: "逐包解压结果",
    reportSummary: (ok: number, fail: number, cancelled: boolean) =>
      cancelled
        ? `已取消 · 成功 ${ok} 个，未完成/失败 ${fail} 个（临时目录已清理）`
        : `完成 · 成功 ${ok} 个，失败/待处理 ${fail} 个`,
    statusLabels: {
      extracted: "已解压",
      needs_password: "需要密码",
      wrong_password: "密码错误",
      conflict: "目标已存在",
      cancelled: "已取消",
      error: "解压失败",
    } as Record<ArchiveExtractStatus, string>,
    reportCounts: (files: number, dirs: number, skipped: number, bytes: string) =>
      `文件 ${files} · 目录 ${dirs} · 跳过 ${skipped} · 写入 ${bytes}`,
    addFilesBtn: "添加文件",
    addFoldersBtn: "添加文件夹",
    clearSourcesBtn: "清空来源",
    pickCreateFilesTitle: "选择要打包的文件",
    pickCreateFoldersTitle: "选择要打包的文件夹",
    dropCreateHint:
      "支持拖入任意文件或文件夹（支持中文路径、嵌套子目录与 0 字节空文件），绝不修改源文件。",
    emptyCreateTitle: "尚未选择待压缩的文件或文件夹",
    createFormatLabel: "压缩格式",
    formatOptZip: "ZIP（标准 Deflate）",
    formatOptZipAes: "ZIP（AES-256 加密，推荐）",
    formatOptZipCrypto: "ZIP（ZipCrypto 兼容加密）",
    formatOptTarGz: "TAR.GZ（标准 Gzip 归档）",
    createPwdLabel: "加密密码（仅本次内存使用，不落盘）",
    createPwdConfirmLabel: "确认密码",
    createPwdPlaceholder: "输入压缩包密码",
    createPwdConfirmPlaceholder: "再次输入密码以确认",
    pwdMismatchWarn: "两次输入的密码不一致。",
    pwdRequiredWarn: "加密 ZIP 格式需要设置非空密码。",
    zipCryptoNote: "提示：ZipCrypto 仅用于旧版解压工具兼容；常规加密推荐使用 AES-256。",
    savePathLabel: "保存压缩包到",
    savePathPlaceholder: "请选择保存路径（默认绝不覆盖源文件）",
    chooseSavePathBtn: "选择保存路径…",
    pickSaveArchiveTitle: "选择压缩包保存位置",
    startCreateBtn: "开始创建压缩包",
    createSuccessTitle: "压缩包创建完成",
    createSuccessMeta: (entries: number, skipped: number, bytes: string) =>
      `写入 ${entries} 项${skipped > 0 ? `（跳过 ${skipped} 个符号链接）` : ""} · 成品大小 ${bytes}`,
    overwriteTitle: "目标压缩包已存在",
    overwriteBody: (path: string) =>
      `目标路径已存在文件：\n${path}\n\n确认覆盖该文件吗？（原待压缩文件不会受到任何修改）`,
    overwriteAccept: "确认覆盖",
    overwriteCancel: "取消",
    needOutputDirErr: "请先选择解压输出目录。",
    needSavePathErr: "请先选择保存路径。",
  },
  "en-US": {
    tabExtract: "Extract Archives",
    tabCreate: "Create Archive",
    matrixSummary: "Supported offline formats (Preview / Extract / Create / Password)",
    matrixColFormat: "Format",
    matrixColExt: "Extensions",
    matrixColPreview: "Preview",
    matrixColExtract: "Extract",
    matrixColCreate: "Create",
    matrixColPassword: "Password / Notes",
    yes: "Yes",
    no: "—",
    addArchivesBtn: "Add Archives",
    clearArchivesBtn: "Clear List",
    pickArchivesTitle: "Select one or more archives",
    dropExtractHint:
      "Drop one or more archives from File Explorer (ZIP, 7z, RAR, TAR, TAR.GZ/XZ/BZ2, single GZ/XZ/BZ2, ISO). Each archive extracts into its own isolated folder so same-name archives never mix.",
    emptyExtractTitle: "No archives added yet",
    emptyExtractBody:
      'Click "Add Archives" or drop archive files here to inspect file lists, paths, and sizes before extracting.',
    inspectingLabel: "Reading archive entries…",
    encryptedBadge: "Password required",
    entriesCount: (n: number) => `${n} item(s)`,
    pwdPlaceholder: "Password (in-memory only)",
    unlockPreviewBtn: "Unlock Preview",
    showPwd: "Show",
    hidePwd: "Hide",
    removeAria: (name: string) => `Remove ${name}`,
    previewHeading: (name: string) => `Contents: ${name}`,
    previewSelectHint: "Select an archive on the left to inspect its file paths and sizes.",
    previewSummary: (count: number, size: string, truncated: boolean) =>
      truncated
        ? `${count} item(s) (showing first 5,000) · Est. uncompressed ${size}`
        : `${count} item(s) · Est. uncompressed ${size}`,
    colPath: "Path",
    colType: "Type",
    colSize: "Size",
    colCompressed: "Packed",
    typeDir: "Folder",
    typeFile: "File",
    typeSymlink: "Symlink (skipped)",
    typeMacos: "macOS metadata",
    lockedTag: "Encrypted",
    outputDirLabel: "Output folder",
    outputDirPlaceholder: "Choose an output parent folder (each archive gets its own subfolder)",
    chooseOutputDirBtn: "Choose Folder…",
    pickOutputDirTitle: "Choose extraction output folder",
    conflictPolicyLabel: "Existing folder policy",
    conflictUnique: "Create unique subfolder (e.g. pack (2))",
    conflictFail: "Protect existing (fail on conflict)",
    skipMacosLabel: "Skip .DS_Store and __MACOSX metadata",
    startExtractBtn: (n: number) => (n > 1 ? `Extract All (${n})` : "Extract Archive"),
    retryFailedBtn: (n: number) => `Retry Password / Failed (${n})`,
    cancelTaskBtn: "Cancel",
    openOutputDirBtn: "Open Output Folder",
    openParentDirBtn: "Open Parent Folder",
    extractProgressTitle: (cur: number, total: number, bytes: string) =>
      `Extracting archive ${cur}/${total} · Written ${bytes}`,
    createProgressTitle: (cur: number, total: number, bytes: string) =>
      `Archiving item ${cur}/${total} · Processed ${bytes}`,
    reportHeading: "Per-Archive Results",
    reportSummary: (ok: number, fail: number, cancelled: boolean) =>
      cancelled
        ? `Cancelled · ${ok} succeeded, ${fail} incomplete/failed (staging cleaned up)`
        : `Finished · ${ok} succeeded, ${fail} failed/pending`,
    statusLabels: {
      extracted: "Extracted",
      needs_password: "Password required",
      wrong_password: "Wrong password",
      conflict: "Target exists",
      cancelled: "Cancelled",
      error: "Failed",
    } as Record<ArchiveExtractStatus, string>,
    reportCounts: (files: number, dirs: number, skipped: number, bytes: string) =>
      `${files} file(s) · ${dirs} folder(s) · ${skipped} skipped · ${bytes}`,
    addFilesBtn: "Add Files",
    addFoldersBtn: "Add Folders",
    clearSourcesBtn: "Clear Sources",
    pickCreateFilesTitle: "Select files to archive",
    pickCreateFoldersTitle: "Select folders to archive",
    dropCreateHint:
      "Drop files or folders from File Explorer (supports Unicode names, nested directories, and 0-byte empty files). Source files are never modified.",
    emptyCreateTitle: "No files or folders selected yet",
    createFormatLabel: "Archive format",
    formatOptZip: "ZIP (Standard Deflate)",
    formatOptZipAes: "ZIP (AES-256 Encrypted, recommended)",
    formatOptZipCrypto: "ZIP (ZipCrypto Legacy Encrypted)",
    formatOptTarGz: "TAR.GZ (Standard Gzip Tarball)",
    createPwdLabel: "Password (in-memory only, never saved)",
    createPwdConfirmLabel: "Confirm password",
    createPwdPlaceholder: "Enter archive password",
    createPwdConfirmPlaceholder: "Re-enter password to confirm",
    pwdMismatchWarn: "Passwords do not match.",
    pwdRequiredWarn: "A non-empty password is required for encrypted ZIP formats.",
    zipCryptoNote:
      "Note: ZipCrypto is for legacy compatibility; prefer AES-256 for strong encryption.",
    savePathLabel: "Save archive as",
    savePathPlaceholder: "Choose output archive path (never overwrites source files)",
    chooseSavePathBtn: "Choose Save Path…",
    pickSaveArchiveTitle: "Save Archive As",
    startCreateBtn: "Create Archive",
    createSuccessTitle: "Archive created successfully",
    createSuccessMeta: (entries: number, skipped: number, bytes: string) =>
      `${entries} entry(ies)${skipped > 0 ? ` (${skipped} symlink(s) skipped)` : ""} · Output size ${bytes}`,
    overwriteTitle: "Target archive already exists",
    overwriteBody: (path: string) =>
      `A file already exists at:\n${path}\n\nOverwrite this archive file? (Source inputs remain untouched.)`,
    overwriteAccept: "Overwrite",
    overwriteCancel: "Cancel",
    needOutputDirErr: "Choose an output folder first.",
    needSavePathErr: "Choose a save path first.",
  },
};

function getStatusPillClass(status: ArchiveExtractStatus): string {
  if (status === "extracted") return "status-pill is-ok";
  if (status === "needs_password" || status === "wrong_password" || status === "conflict") {
    return "status-pill is-warn";
  }
  return "status-pill is-err";
}

export function ArchiveWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const {
    session,
    updateArchiveSession,
    startArchiveExtract,
    startArchiveCreate,
    cancelArchiveTask,
  } = useSessionStore();
  const state = session.archive;

  // Passwords live strictly in component memory for active use and are never persisted.
  const [extractPasswords, setExtractPasswords] = useState<Record<string, string>>({});
  const [showExtractPwd, setShowExtractPwd] = useState<Record<string, boolean>>({});
  const [createPassword, setCreatePassword] = useState("");
  const [createPasswordConfirm, setCreatePasswordConfirm] = useState("");
  const [showCreatePwd, setShowCreatePwd] = useState(false);

  const [inspectingPaths, setInspectingPaths] = useState<Record<string, boolean>>({});
  const [dropHover, setDropHover] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);

  const busy = state.status === "extracting" || state.status === "creating";

  const inspectOneArchive = useCallback(
    async (archivePath: string, password?: string) => {
      setInspectingPaths((prev) => ({ ...prev, [archivePath]: true }));
      try {
        const preview = await inspectArchive(archivePath, password ?? null);
        updateArchiveSession((prev) => {
          const nextErrors = { ...prev.extractInspectErrors };
          delete nextErrors[archivePath];
          return {
            ...prev,
            extractPreviews: {
              ...prev.extractPreviews,
              [archivePath]: preview,
            },
            extractInspectErrors: nextErrors,
          };
        });
      } catch (err) {
        const formatted = formatLocalizedError(err, messages);
        updateArchiveSession((prev) => ({
          ...prev,
          extractInspectErrors: {
            ...prev.extractInspectErrors,
            [archivePath]: formatted,
          },
        }));
      } finally {
        setInspectingPaths((prev) => {
          const next = { ...prev };
          delete next[archivePath];
          return next;
        });
      }
    },
    [messages, updateArchiveSession],
  );

  const appendExtractArchives = useCallback(
    (incoming: string[]) => {
      const cleaned = incoming.map((p) => p.trim()).filter((p) => p.length > 0);
      if (cleaned.length === 0) return;

      const added: string[] = [];
      updateArchiveSession((prev) => {
        const seen = new Set(prev.extractPaths.map((p) => p.toLowerCase()));
        const nextPaths = [...prev.extractPaths];
        for (const cand of cleaned) {
          const key = cand.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            nextPaths.push(cand);
            added.push(cand);
          }
        }
        return {
          ...prev,
          extractPaths: nextPaths,
          selectedPreviewPath: prev.selectedPreviewPath ?? nextPaths[0] ?? null,
          errorMessage: null,
        };
      });

      for (const path of added) {
        void inspectOneArchive(path);
      }
    },
    [inspectOneArchive, updateArchiveSession],
  );

  const appendCreateSources = useCallback(
    (incoming: string[]) => {
      const cleaned = incoming.map((p) => p.trim()).filter((p) => p.length > 0);
      if (cleaned.length === 0) return;
      updateArchiveSession((prev) => {
        const seen = new Set(prev.createSourcePaths.map((p) => p.toLowerCase()));
        const next = [...prev.createSourcePaths];
        for (const cand of cleaned) {
          const key = cand.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            next.push(cand);
          }
        }
        return {
          ...prev,
          createSourcePaths: next,
          errorMessage: null,
        };
      });
    },
    [updateArchiveSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (busy) return;
            if (state.activeTab === "extract") {
              appendExtractArchives(paths);
            } else {
              appendCreateSources(paths);
            }
          },
        }),
      "f04-archive-file-drop",
    );
  }, [appendCreateSources, appendExtractArchives, busy, state.activeTab]);

  const handlePickArchives = async () => {
    if (busy) return;
    const picked = await pickMultipleFiles({
      title: t.pickArchivesTitle,
      filters: [{ name: "Archives", extensions: ARCHIVE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked.length > 0) {
      appendExtractArchives(picked);
    }
  };

  const handleRemoveExtractArchive = (targetPath: string) => {
    if (busy) return;
    updateArchiveSession((prev) => {
      const nextPaths = prev.extractPaths.filter((p) => p !== targetPath);
      const nextPreviews = { ...prev.extractPreviews };
      delete nextPreviews[targetPath];
      const nextErrors = { ...prev.extractInspectErrors };
      delete nextErrors[targetPath];
      return {
        ...prev,
        extractPaths: nextPaths,
        extractPreviews: nextPreviews,
        extractInspectErrors: nextErrors,
        selectedPreviewPath:
          prev.selectedPreviewPath === targetPath
            ? (nextPaths[0] ?? null)
            : prev.selectedPreviewPath,
      };
    });
    setExtractPasswords((prev) => {
      const next = { ...prev };
      delete next[targetPath];
      return next;
    });
  };

  const handleClearExtract = () => {
    if (busy) return;
    setExtractPasswords({});
    setShowExtractPwd({});
    updateArchiveSession({
      extractPaths: [],
      extractPreviews: {},
      extractInspectErrors: {},
      selectedPreviewPath: null,
      lastExtractReport: null,
      errorMessage: null,
    });
  };

  const handlePickOutputDir = async () => {
    if (busy) return;
    const picked = await pickSingleDirectory({ title: t.pickOutputDirTitle });
    if (picked) {
      updateArchiveSession({ outputParentDir: picked, errorMessage: null });
    }
  };

  const runExtract = async (targetPaths: string[]) => {
    if (busy || targetPaths.length === 0) return;
    if (!state.outputParentDir.trim()) {
      updateArchiveSession({ errorMessage: t.needOutputDirErr });
      return;
    }

    const pwdMap: Record<string, string> = {};
    for (const p of targetPaths) {
      const pwd = extractPasswords[p];
      if (pwd && pwd.length > 0) {
        pwdMap[p] = pwd;
      }
    }

    await startArchiveExtract(
      {
        archivePaths: targetPaths,
        outputParentDir: state.outputParentDir,
        passwords: pwdMap,
        skipMacosMetadata: state.skipMacosMetadata,
        conflictPolicy: state.conflictPolicy,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const retryableFailedPaths = useMemo(() => {
    if (!state.lastExtractReport) return [];
    return state.lastExtractReport.items
      .filter(
        (item) =>
          item.status === "needs_password" ||
          item.status === "wrong_password" ||
          item.status === "conflict" ||
          item.status === "error",
      )
      .map((item) => item.archivePath);
  }, [state.lastExtractReport]);

  const selectedPreview = state.selectedPreviewPath
    ? (state.extractPreviews[state.selectedPreviewPath] ?? null)
    : null;
  const selectedInspectError = state.selectedPreviewPath
    ? (state.extractInspectErrors[state.selectedPreviewPath] ?? null)
    : null;

  const handlePickCreateFiles = async () => {
    if (busy) return;
    const picked = await pickMultipleFiles({ title: t.pickCreateFilesTitle });
    if (picked.length > 0) {
      appendCreateSources(picked);
    }
  };

  const handlePickCreateFolders = async () => {
    if (busy) return;
    const picked = await pickMultipleDirectories({ title: t.pickCreateFoldersTitle });
    if (picked.length > 0) {
      appendCreateSources(picked);
    }
  };

  const handleClearCreate = () => {
    if (busy) return;
    setCreatePassword("");
    setCreatePasswordConfirm("");
    updateArchiveSession({
      createSourcePaths: [],
      createOutputPath: "",
      lastCreateReport: null,
      errorMessage: null,
    });
  };

  const handlePickCreateSavePath = async () => {
    if (busy) return;
    const ext = getCreateExtension(state.createFormat);
    const defaultName = suggestCreateOutputFilename(state.createSourcePaths, state.createFormat);
    const picked = await pickSaveFilePath({
      title: t.pickSaveArchiveTitle,
      defaultPath: state.createOutputPath || defaultName,
      filters:
        ext === "tar.gz"
          ? [{ name: "TAR.GZ Archive", extensions: ["gz", "tgz"] }]
          : [{ name: "ZIP Archive", extensions: ["zip"] }],
    });
    if (picked) {
      updateArchiveSession({ createOutputPath: picked, errorMessage: null });
    }
  };

  const needsCreatePassword = createFormatRequiresPassword(state.createFormat);
  const createPasswordMismatch =
    needsCreatePassword &&
    createPasswordConfirm.length > 0 &&
    createPassword !== createPasswordConfirm;

  const runCreate = async (overwrite: boolean) => {
    if (busy || state.createSourcePaths.length === 0) return;
    if (!state.createOutputPath.trim()) {
      updateArchiveSession({ errorMessage: t.needSavePathErr });
      return;
    }
    if (needsCreatePassword) {
      if (!createPassword) {
        updateArchiveSession({ errorMessage: t.pwdRequiredWarn });
        return;
      }
      if (createPassword !== createPasswordConfirm) {
        updateArchiveSession({ errorMessage: t.pwdMismatchWarn });
        return;
      }
    }

    const { errorCode } = await startArchiveCreate(
      {
        sourcePaths: state.createSourcePaths,
        outputPath: state.createOutputPath,
        format: state.createFormat,
        password: needsCreatePassword ? createPassword : null,
        overwrite,
      },
      (err) => formatLocalizedError(err, messages),
    );
    if (errorCode === "TARGET_ALREADY_EXISTS") {
      setOverwriteConfirmOpen(true);
    }
  };

  const handleOpenFolder = async (dirPath: string) => {
    try {
      await openLocalDirectory(dirPath);
    } catch (err) {
      updateArchiveSession({ errorMessage: formatLocalizedError(err, messages) });
    }
  };

  return (
    <div className="archive-workspace">
      <div className="archive-topbar">
        <div className="segmented-control" role="tablist" aria-label="Archive workspace mode">
          <button
            type="button"
            role="tab"
            aria-selected={state.activeTab === "extract"}
            className={`seg-btn ${state.activeTab === "extract" ? "is-active" : ""}`}
            disabled={busy}
            onClick={() => updateArchiveSession({ activeTab: "extract", errorMessage: null })}
          >
            {t.tabExtract}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.activeTab === "create"}
            className={`seg-btn ${state.activeTab === "create" ? "is-active" : ""}`}
            disabled={busy}
            onClick={() => updateArchiveSession({ activeTab: "create", errorMessage: null })}
          >
            {t.tabCreate}
          </button>
        </div>
      </div>

      <details className="archive-matrix-details">
        <summary>{t.matrixSummary}</summary>
        <div className="archive-matrix-wrap">
          <table className="archive-table">
            <thead>
              <tr>
                <th>{t.matrixColFormat}</th>
                <th>{t.matrixColExt}</th>
                <th>{t.matrixColPreview}</th>
                <th>{t.matrixColExtract}</th>
                <th>{t.matrixColCreate}</th>
                <th>{t.matrixColPassword}</th>
              </tr>
            </thead>
            <tbody>
              {ARCHIVE_SUPPORT_MATRIX.map((row) => (
                <tr key={row.formatLabel}>
                  <td>{row.formatLabel}</td>
                  <td className="archive-mono-cell">{row.extensions}</td>
                  <td>{row.preview ? t.yes : t.no}</td>
                  <td>{row.extract ? t.yes : t.no}</td>
                  <td>{row.create ? t.yes : t.no}</td>
                  <td>{row.password[locale]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {state.errorMessage && (
        <div className="inline-banner is-err" role="alert">
          {state.errorMessage}
        </div>
      )}

      {state.liveProgress && (
        <div className="archive-progress-box" role="status" aria-live="polite">
          <div className="archive-progress-top">
            <strong>
              {state.liveProgress.operation === "extract"
                ? t.extractProgressTitle(
                    state.liveProgress.currentIndex,
                    state.liveProgress.totalItems,
                    formatArchiveBytes(state.liveProgress.processedBytes),
                  )
                : t.createProgressTitle(
                    state.liveProgress.currentIndex,
                    state.liveProgress.totalItems,
                    formatArchiveBytes(state.liveProgress.processedBytes),
                  )}
            </strong>
            <button type="button" className="btn btn-secondary" onClick={cancelArchiveTask}>
              {t.cancelTaskBtn}
            </button>
          </div>
          {state.liveProgress.currentItem && (
            <div className="archive-item-path">{state.liveProgress.currentItem}</div>
          )}
        </div>
      )}

      {state.activeTab === "extract" ? (
        <>
          <section className={`archive-panel ${dropHover ? "is-drop-hover" : ""}`}>
            <div className="archive-toolbar">
              <div className="archive-toolbar-group">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={handlePickArchives}
                >
                  {t.addArchivesBtn}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || state.extractPaths.length === 0}
                  onClick={handleClearExtract}
                >
                  {t.clearArchivesBtn}
                </button>
              </div>
              <span className="archive-hint">{t.entriesCount(state.extractPaths.length)}</span>
            </div>
            <p className="archive-hint">{t.dropExtractHint}</p>

            {state.extractPaths.length === 0 ? (
              <div className="archive-empty-box">
                <strong>{t.emptyExtractTitle}</strong>
                <div>{t.emptyExtractBody}</div>
              </div>
            ) : (
              <div className="archive-split">
                <div className="archive-list" role="list">
                  {state.extractPaths.map((archivePath) => {
                    const preview = state.extractPreviews[archivePath];
                    const inspectErr = state.extractInspectErrors[archivePath];
                    const isInspecting = Boolean(inspectingPaths[archivePath]);
                    const isSelected = state.selectedPreviewPath === archivePath;
                    const baseName = preview?.archiveName ?? extractBaseFileName(archivePath);
                    const lastReport = state.lastExtractReport?.items.find(
                      (i) => i.archivePath === archivePath,
                    );
                    const showPwdControls =
                      Boolean(preview?.needsPassword) ||
                      lastReport?.status === "needs_password" ||
                      lastReport?.status === "wrong_password" ||
                      Boolean(extractPasswords[archivePath]);

                    return (
                      <div
                        key={archivePath}
                        role="listitem"
                        className={`archive-item-card ${isSelected ? "is-selected" : ""}`}
                      >
                        <div className="archive-item-header">
                          <button
                            type="button"
                            className="archive-item-select-btn"
                            onClick={() =>
                              updateArchiveSession({ selectedPreviewPath: archivePath })
                            }
                          >
                            <span className="archive-item-name">{baseName}</span>
                            <span className="archive-item-path">{archivePath}</span>
                          </button>
                          <button
                            type="button"
                            className="archive-remove-btn"
                            disabled={busy}
                            aria-label={t.removeAria(baseName)}
                            onClick={() => handleRemoveExtractArchive(archivePath)}
                          >
                            ×
                          </button>
                        </div>

                        <div className="archive-item-badges">
                          {isInspecting && <span className="status-pill">{t.inspectingLabel}</span>}
                          {preview && (
                            <>
                              <span className="status-pill">
                                {formatArchiveFormatLabel(preview.format, locale)}
                              </span>
                              <span className="status-pill">
                                {formatArchiveBytes(preview.archiveByteLength)}
                              </span>
                              <span className="status-pill">
                                {t.entriesCount(preview.totalEntries)}
                              </span>
                              {preview.needsPassword && (
                                <span className="status-pill is-warn">{t.encryptedBadge}</span>
                              )}
                            </>
                          )}
                          {inspectErr && <span className="status-pill is-err">{inspectErr}</span>}
                        </div>

                        {showPwdControls && (
                          <div className="archive-pwd-row">
                            <input
                              type={showExtractPwd[archivePath] ? "text" : "password"}
                              className="text-input archive-pwd-input"
                              placeholder={t.pwdPlaceholder}
                              value={extractPasswords[archivePath] ?? ""}
                              disabled={busy}
                              aria-label={`${baseName} password`}
                              onChange={(e) =>
                                setExtractPasswords((prev) => ({
                                  ...prev,
                                  [archivePath]: e.target.value,
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busy}
                              onClick={() =>
                                setShowExtractPwd((prev) => ({
                                  ...prev,
                                  [archivePath]: !prev[archivePath],
                                }))
                              }
                            >
                              {showExtractPwd[archivePath] ? t.hidePwd : t.showPwd}
                            </button>
                            <button
                              type="button"
                              className="btn btn-secondary"
                              disabled={busy || isInspecting}
                              onClick={() =>
                                void inspectOneArchive(archivePath, extractPasswords[archivePath])
                              }
                            >
                              {t.unlockPreviewBtn}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div>
                  {selectedPreview ? (
                    <>
                      <div className="archive-toolbar" style={{ marginBottom: 8 }}>
                        <strong>{t.previewHeading(selectedPreview.archiveName)}</strong>
                        <span className="archive-hint">
                          {t.previewSummary(
                            selectedPreview.totalEntries,
                            formatArchiveBytes(selectedPreview.totalUncompressedBytes),
                            selectedPreview.entriesTruncated,
                          )}
                        </span>
                      </div>
                      <div className="archive-table-wrap">
                        <table className="archive-table">
                          <thead>
                            <tr>
                              <th>{t.colPath}</th>
                              <th>{t.colType}</th>
                              <th className="archive-num-cell">{t.colSize}</th>
                              <th className="archive-num-cell">{t.colCompressed}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {selectedPreview.entries.map((entry, idx) => (
                              <tr key={`${entry.path}-${idx}`}>
                                <td className="archive-mono-cell">
                                  {entry.path}
                                  {entry.encrypted && (
                                    <span className="status-pill is-warn" style={{ marginLeft: 6 }}>
                                      {t.lockedTag}
                                    </span>
                                  )}
                                </td>
                                <td>
                                  {entry.isSymlink
                                    ? t.typeSymlink
                                    : entry.isMacosMetadata
                                      ? t.typeMacos
                                      : entry.isDir
                                        ? t.typeDir
                                        : t.typeFile}
                                </td>
                                <td className="archive-num-cell">
                                  {entry.uncompressedSize !== null
                                    ? formatArchiveBytes(entry.uncompressedSize)
                                    : "—"}
                                </td>
                                <td className="archive-num-cell">
                                  {entry.compressedSize !== null
                                    ? formatArchiveBytes(entry.compressedSize)
                                    : "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  ) : (
                    <div className="archive-empty-box">
                      {selectedInspectError ?? t.previewSelectHint}
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>

          <section className="archive-panel">
            <div className="archive-output-row">
              <strong style={{ fontSize: 12.5 }}>{t.outputDirLabel}</strong>
              <div
                className={`archive-path-box ${state.outputParentDir ? "" : "is-placeholder"}`}
                title={state.outputParentDir || undefined}
              >
                {state.outputParentDir || t.outputDirPlaceholder}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={handlePickOutputDir}
              >
                {t.chooseOutputDirBtn}
              </button>
            </div>

            <div className="archive-options-grid">
              <div className="archive-toolbar-group">
                <label className="archive-field-label" htmlFor="archive-conflict-policy">
                  {t.conflictPolicyLabel}
                </label>
                <select
                  id="archive-conflict-policy"
                  className="select-input"
                  value={state.conflictPolicy}
                  disabled={busy}
                  onChange={(e) =>
                    updateArchiveSession({
                      conflictPolicy: e.target.value as ExtractConflictPolicy,
                    })
                  }
                >
                  <option value="unique_folder">{t.conflictUnique}</option>
                  <option value="fail_if_exists">{t.conflictFail}</option>
                </select>
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={state.skipMacosMetadata}
                    disabled={busy}
                    onChange={(e) => updateArchiveSession({ skipMacosMetadata: e.target.checked })}
                  />
                  <span>{t.skipMacosLabel}</span>
                </label>
              </div>

              <div className="archive-toolbar-group">
                {retryableFailedPaths.length > 0 && !busy && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => void runExtract(retryableFailedPaths)}
                  >
                    {t.retryFailedBtn(retryableFailedPaths.length)}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || state.extractPaths.length === 0 || !state.outputParentDir}
                  onClick={() => void runExtract(state.extractPaths)}
                >
                  {t.startExtractBtn(state.extractPaths.length)}
                </button>
              </div>
            </div>
          </section>

          {state.lastExtractReport && (
            <section className="archive-panel">
              <div className="archive-toolbar">
                <div className="archive-toolbar-group">
                  <strong>{t.reportHeading}</strong>
                  <span className="archive-hint">
                    {t.reportSummary(
                      state.lastExtractReport.succeededCount,
                      state.lastExtractReport.failedCount,
                      state.lastExtractReport.cancelled,
                    )}
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleOpenFolder(state.lastExtractReport!.outputParentDir)}
                >
                  {t.openParentDirBtn}
                </button>
              </div>

              <div className="archive-report-list">
                {state.lastExtractReport.items.map((item) => (
                  <div key={item.archivePath} className="archive-report-row">
                    <div className="archive-report-meta">
                      <div className="archive-item-badges">
                        <strong>{item.archiveName}</strong>
                        <span className={getStatusPillClass(item.status)}>
                          {t.statusLabels[item.status]}
                        </span>
                        {item.format && (
                          <span className="status-pill">
                            {formatArchiveFormatLabel(item.format, locale)}
                          </span>
                        )}
                      </div>
                      <span className="archive-hint">
                        {t.reportCounts(
                          item.extractedFiles,
                          item.extractedDirs,
                          item.skippedEntries,
                          formatArchiveBytes(item.writtenBytes),
                        )}
                      </span>
                      {item.outputDir && (
                        <span className="archive-item-path">{item.outputDir}</span>
                      )}
                      {item.message && <span className="archive-hint">{item.message}</span>}
                    </div>

                    {item.outputDir && item.status === "extracted" && (
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => void handleOpenFolder(item.outputDir!)}
                      >
                        {t.openOutputDirBtn}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </>
      ) : (
        <>
          <section className={`archive-panel ${dropHover ? "is-drop-hover" : ""}`}>
            <div className="archive-toolbar">
              <div className="archive-toolbar-group">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={handlePickCreateFiles}
                >
                  {t.addFilesBtn}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy}
                  onClick={handlePickCreateFolders}
                >
                  {t.addFoldersBtn}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busy || state.createSourcePaths.length === 0}
                  onClick={handleClearCreate}
                >
                  {t.clearSourcesBtn}
                </button>
              </div>
              <span className="archive-hint">{t.entriesCount(state.createSourcePaths.length)}</span>
            </div>
            <p className="archive-hint">{t.dropCreateHint}</p>

            {state.createSourcePaths.length === 0 ? (
              <div className="archive-empty-box">{t.emptyCreateTitle}</div>
            ) : (
              <div className="archive-source-chips">
                {state.createSourcePaths.map((srcPath) => (
                  <span key={srcPath} className="archive-source-chip" title={srcPath}>
                    <span className="archive-source-chip-path">{srcPath}</span>
                    <button
                      type="button"
                      className="archive-remove-btn"
                      disabled={busy}
                      aria-label={t.removeAria(extractBaseFileName(srcPath))}
                      onClick={() =>
                        updateArchiveSession((prev) => ({
                          ...prev,
                          createSourcePaths: prev.createSourcePaths.filter((p) => p !== srcPath),
                        }))
                      }
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </section>

          <section className="archive-panel">
            <div className="archive-create-form">
              <div className="archive-field">
                <label className="archive-field-label" htmlFor="archive-create-format">
                  {t.createFormatLabel}
                </label>
                <select
                  id="archive-create-format"
                  className="select-input"
                  value={state.createFormat}
                  disabled={busy}
                  onChange={(e) => {
                    const nextFmt = e.target.value as ArchiveCreateFormat;
                    if (!createFormatRequiresPassword(nextFmt)) {
                      setCreatePassword("");
                      setCreatePasswordConfirm("");
                    }
                    updateArchiveSession({ createFormat: nextFmt, errorMessage: null });
                  }}
                >
                  <option value="zip">{t.formatOptZip}</option>
                  <option value="zip_aes256">{t.formatOptZipAes}</option>
                  <option value="zip_zipcrypto">{t.formatOptZipCrypto}</option>
                  <option value="tar_gz">{t.formatOptTarGz}</option>
                </select>
              </div>

              {needsCreatePassword && (
                <>
                  <div className="archive-field">
                    <label className="archive-field-label" htmlFor="archive-create-pwd">
                      {t.createPwdLabel}
                    </label>
                    <div className="archive-pwd-row">
                      <input
                        id="archive-create-pwd"
                        type={showCreatePwd ? "text" : "password"}
                        className="text-input archive-pwd-input"
                        placeholder={t.createPwdPlaceholder}
                        value={createPassword}
                        disabled={busy}
                        onChange={(e) => setCreatePassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy}
                        onClick={() => setShowCreatePwd((v) => !v)}
                      >
                        {showCreatePwd ? t.hidePwd : t.showPwd}
                      </button>
                    </div>
                  </div>

                  <div className="archive-field">
                    <label className="archive-field-label" htmlFor="archive-create-pwd-confirm">
                      {t.createPwdConfirmLabel}
                    </label>
                    <input
                      id="archive-create-pwd-confirm"
                      type={showCreatePwd ? "text" : "password"}
                      className="text-input"
                      placeholder={t.createPwdConfirmPlaceholder}
                      value={createPasswordConfirm}
                      disabled={busy}
                      onChange={(e) => setCreatePasswordConfirm(e.target.value)}
                    />
                  </div>
                </>
              )}
            </div>

            {state.createFormat === "zip_zipcrypto" && (
              <p className="archive-hint">{t.zipCryptoNote}</p>
            )}
            {createPasswordMismatch && (
              <div className="inline-banner is-warn">{t.pwdMismatchWarn}</div>
            )}

            <div className="archive-output-row">
              <strong style={{ fontSize: 12.5 }}>{t.savePathLabel}</strong>
              <div
                className={`archive-path-box ${state.createOutputPath ? "" : "is-placeholder"}`}
                title={state.createOutputPath || undefined}
              >
                {state.createOutputPath || t.savePathPlaceholder}
              </div>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={handlePickCreateSavePath}
              >
                {t.chooseSavePathBtn}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={
                  busy ||
                  state.createSourcePaths.length === 0 ||
                  !state.createOutputPath ||
                  (needsCreatePassword && (!createPassword || createPasswordMismatch))
                }
                onClick={() => void runCreate(false)}
              >
                {t.startCreateBtn}
              </button>
            </div>
          </section>

          {state.lastCreateReport && (
            <section className="archive-panel">
              <div className="archive-report-row">
                <div className="archive-report-meta">
                  <div className="archive-item-badges">
                    <strong>{t.createSuccessTitle}</strong>
                    <span className="status-pill is-ok">
                      {formatArchiveFormatLabel(state.lastCreateReport.format, locale)}
                    </span>
                  </div>
                  <span className="archive-hint">
                    {t.createSuccessMeta(
                      state.lastCreateReport.entryCount,
                      state.lastCreateReport.skippedCount,
                      formatArchiveBytes(state.lastCreateReport.outputByteLength),
                    )}
                  </span>
                  <span className="archive-item-path">{state.lastCreateReport.outputPath}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => void handleOpenFolder(state.lastCreateReport!.outputParentDir)}
                >
                  {t.openOutputDirBtn}
                </button>
              </div>
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={overwriteConfirmOpen}
        title={t.overwriteTitle}
        body={t.overwriteBody(state.createOutputPath)}
        confirmLabel={t.overwriteAccept}
        cancelLabel={t.overwriteCancel}
        onCancel={() => setOverwriteConfirmOpen(false)}
        onConfirm={() => {
          setOverwriteConfirmOpen(false);
          void runCreate(true);
        }}
      />
    </div>
  );
}
