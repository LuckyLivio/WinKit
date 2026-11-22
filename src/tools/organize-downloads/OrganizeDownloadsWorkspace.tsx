import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  executeOrganizeDownloads,
  formatLocalizedError,
  openLocalDirectory,
  pickSingleDirectory,
  previewOrganizeDownloads,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import {
  DEFAULT_DOMAIN_MAPPINGS,
  formatOrganizeBytes,
  normalizeDomainRuleInput,
  validateDomainMappingInput,
  type DomainMappingRule,
  type OrganizeItemStatus,
  type OrganizeNamingMode,
} from "./organizeEngine";
import "./organizeDownloadsWorkspace.css";

type FilterMode = "all" | "move" | "already" | "stay" | "conflict";

const copy = {
  "zh-CN": {
    chooseFolderBtn: "选择图片文件夹…",
    refreshBtn: "刷新预览",
    clearBtn: "清空",
    openFolderBtn: "打开目标文件夹",
    pickFolderTitle: "选择要按来源归档图片的本地文件夹",
    folderPlaceholder: "请手动选择一个本地图片文件夹（不会自动扫描日常下载目录）",
    privacyHint:
      "仅在您手动选择文件夹后本地读取 NTFS Zone.Identifier（HostUrl / ReferrerUrl）中的域名并按来源归档；不读取浏览器历史，不记录完整 URL 或查询参数，移动时原样保留 ZoneId 与安全流。",
    namingModeLabel: "目录命名方式",
    namingSiteAlias: "站点名称优先（支持 CDN 映射，未命中用域名）",
    namingDomainOnly: "始终按原始域名命名",
    unknownToggleLabel: "将无来源 / 无法识别的图片移入「未知来源」文件夹（默认保持原位不动）",
    unknownFolderDefault: "未知来源",
    mappingSummary: (n: number) => `编辑常用图床 / CDN 到站点名称映射规则（当前 ${n} 条）`,
    mappingDomainPlaceholder: "域名（如 i.imgur.com）",
    mappingSitePlaceholder: "目录名（如 Imgur）",
    mappingAddBtn: "添加 / 更新规则",
    mappingResetBtn: "恢复默认规则",
    mappingRuleNote:
      "匹配采用严格域边界规则（完全相等或子域名匹配，如 pbs.twimg.com 归入 X (Twitter)，不会误匹配后缀近似域名）。",
    mappingErrors: {
      empty_domain: "请输入有效域名。",
      invalid_domain: "域名格式不正确，请输入如 i.imgur.com 的标准域名。",
      empty_site: "请输入目标站点目录名称。",
      invalid_site: "目录名称不能包含 Windows 非法路径字符。",
    },
    unsupportedFsWarn:
      "当前目录所在磁盘不支持 NTFS Zone.Identifier 备用数据流（如 FAT32 / exFAT），无法读取下载来源，图片默认保持原位。",
    badgeReady: (n: number) => `待移动 ${n}`,
    badgeAlready: (n: number) => `已归档 ${n}`,
    badgeStay: (n: number) => `保持原位 ${n}`,
    badgeConflict: (n: number) => `冲突跳过 ${n}`,
    badgeNonImage: (n: number) => `忽略非图片 ${n}`,
    filterAll: "全部",
    filterMove: "待移动",
    filterAlready: "已归档",
    filterStay: "保持原位",
    filterConflict: "冲突",
    executeBtn: (n: number) => (n > 0 ? `开始归档 (${n} 张)` : "无可移动图片"),
    emptyFolderTitle: "尚未选择本地图片文件夹",
    emptyFolderBody:
      "点击“选择图片文件夹…”或从资源管理器拖入一个本地文件夹后，即可先预览每张图片的来源域名与目标路径。",
    emptyImagesBody:
      "该文件夹下未发现受支持的图片文件（PNG/JPG/WebP/GIF/BMP/AVIF/HEIC/TIFF/SVG）。",
    colFile: "图片文件",
    colSource: "识别来源 / 站点",
    colTarget: "目标相对路径",
    colStatus: "状态 / 原因",
    sourceUnknown: "无来源信息",
    targetUnchanged: "保持原位",
    statusLabels: {
      ready: "待移动",
      already_organized: "已归档",
      no_source: "无来源（保持原位）",
      metadata_unreadable: "元数据不可读",
      unsupported_fs: "非 NTFS / 不支持",
      conflict_exists: "目标同名冲突",
      invalid_target: "目标目录名非法",
    } as Record<OrganizeItemStatus, string>,
    confirmTitle: "确认按来源移动图片",
    confirmBody: (count: number, folder: string) =>
      `即将把 ${count} 张图片按识别来源移动到以下目录的对应子文件夹中：\n${folder}\n\n移动前将逐项重新校验文件内容与元数据（预览后被修改的图片将自动跳过），目标已存在同名文件时绝不覆盖，并完整保留原文件的 Zone.Identifier 安全标识。`,
    confirmAccept: "确认归档",
    confirmCancel: "取消",
    execResultHeading: "本次归档结果",
    execSummary: (moved: number, skipped: number, failed: number) =>
      `已移动 ${moved} 张 · 跳过 ${skipped} 张 · 失败 ${failed} 张`,
    execDetailsSummary: (n: number) => `查看逐项执行结果（${n} 项）`,
    execOutcomeLabels: {
      moved: "已移动",
      skipped: "已跳过",
      failed: "失败",
    },
    loadingPreview: "正在读取本地图片与 Zone.Identifier 预览…",
    executingLabel: "正在校验并移动图片…",
    removeRuleAria: (d: string) => `删除映射规则 ${d}`,
  },
  "en-US": {
    chooseFolderBtn: "Choose Image Folder…",
    refreshBtn: "Refresh Preview",
    clearBtn: "Clear",
    openFolderBtn: "Open Target Folder",
    pickFolderTitle: "Choose a local image folder to organize by download source",
    folderPlaceholder:
      "Manually choose a local image folder (never auto-scans your Downloads folder)",
    privacyHint:
      "Reads existing NTFS Zone.Identifier (HostUrl / ReferrerUrl) locally only for the folder you choose. Never reads browser history or logs full URLs/query parameters, and preserves ZoneId and ADS intact when moving.",
    namingModeLabel: "Folder naming",
    namingSiteAlias: "Friendly site name (CDN mapping, domain fallback)",
    namingDomainOnly: "Original domain name only",
    unknownToggleLabel:
      'Move images without source metadata into "Unknown Source" (default: keep in place)',
    unknownFolderDefault: "Unknown Source",
    mappingSummary: (n: number) => `Edit CDN / site domain mapping rules (${n} rules)`,
    mappingDomainPlaceholder: "Domain (e.g. i.imgur.com)",
    mappingSitePlaceholder: "Folder name (e.g. Imgur)",
    mappingAddBtn: "Add / Update Rule",
    mappingResetBtn: "Reset Defaults",
    mappingRuleNote:
      "Uses strict domain-boundary matching (exact host or subdomain match only; suffix lookalikes never match).",
    mappingErrors: {
      empty_domain: "Enter a domain name.",
      invalid_domain: "Enter a valid domain such as i.imgur.com.",
      empty_site: "Enter a target folder name.",
      invalid_site: "Folder name contains illegal Windows path characters.",
    },
    unsupportedFsWarn:
      "This volume does not support NTFS Zone.Identifier Alternate Data Streams (e.g. FAT32 / exFAT). Images stay in place by default.",
    badgeReady: (n: number) => `${n} to move`,
    badgeAlready: (n: number) => `${n} already organized`,
    badgeStay: (n: number) => `${n} stay in place`,
    badgeConflict: (n: number) => `${n} conflict`,
    badgeNonImage: (n: number) => `${n} non-image ignored`,
    filterAll: "All",
    filterMove: "Ready",
    filterAlready: "Already organized",
    filterStay: "Stay in place",
    filterConflict: "Conflicts",
    executeBtn: (n: number) => (n > 0 ? `Organize Now (${n})` : "Nothing to Move"),
    emptyFolderTitle: "No image folder selected yet",
    emptyFolderBody:
      'Click "Choose Image Folder…" or drop a local folder here to preview detected source domains and target subfolders before moving anything.',
    emptyImagesBody:
      "No supported image files (PNG/JPG/WebP/GIF/BMP/AVIF/HEIC/TIFF/SVG) were found in this folder.",
    colFile: "Image File",
    colSource: "Detected Source / Site",
    colTarget: "Target Relative Path",
    colStatus: "Status / Reason",
    sourceUnknown: "No source metadata",
    targetUnchanged: "Stay in place",
    statusLabels: {
      ready: "Ready to move",
      already_organized: "Already organized",
      no_source: "No source (stay)",
      metadata_unreadable: "Metadata unreadable",
      unsupported_fs: "Non-NTFS / unsupported",
      conflict_exists: "Target exists",
      invalid_target: "Invalid folder name",
    } as Record<OrganizeItemStatus, string>,
    confirmTitle: "Confirm Organizing Images by Source",
    confirmBody: (count: number, folder: string) =>
      `Move ${count} image(s) into per-source subfolders under:\n${folder}\n\nWinKit re-verifies each file before moving (skipping any file changed after preview), never overwrites existing targets, and preserves original Zone.Identifier streams byte-for-byte.`,
    confirmAccept: "Move Images",
    confirmCancel: "Cancel",
    execResultHeading: "Organization Results",
    execSummary: (moved: number, skipped: number, failed: number) =>
      `Moved ${moved} · Skipped ${skipped} · Failed ${failed}`,
    execDetailsSummary: (n: number) => `Inspect per-file outcomes (${n} item(s))`,
    execOutcomeLabels: {
      moved: "Moved",
      skipped: "Skipped",
      failed: "Failed",
    },
    loadingPreview: "Inspecting local images and Zone.Identifier metadata…",
    executingLabel: "Verifying and moving images…",
    removeRuleAria: (d: string) => `Remove rule for ${d}`,
  },
};

function statusPillClass(status: OrganizeItemStatus): string {
  if (status === "ready" || status === "already_organized") return "status-pill is-ok";
  if (status === "conflict_exists" || status === "invalid_target") return "status-pill is-err";
  return "status-pill is-warn";
}

export function OrganizeDownloadsWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateOrganizeDownloadsSession } = useSessionStore();
  const state = session.organizeDownloads;

  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const [newDomain, setNewDomain] = useState("");
  const [newSite, setNewSite] = useState("");
  const [mappingError, setMappingError] = useState<string | null>(null);

  const previewSeqRef = useRef(0);
  const busy = loading || executing;

  const runPreview = useCallback(
    async (
      folderPath: string,
      namingMode: OrganizeNamingMode,
      moveUnknownToFolder: boolean,
      mappings: DomainMappingRule[],
    ) => {
      const trimmed = folderPath.trim();
      if (!trimmed) return;
      const reqId = ++previewSeqRef.current;
      setLoading(true);
      try {
        const res = await previewOrganizeDownloads({
          folderPath: trimmed,
          namingMode,
          moveUnknownToFolder,
          unknownFolderName: t.unknownFolderDefault,
          mappings: mappings.map((m) => ({ domain: m.domain, siteName: m.siteName })),
        });
        if (previewSeqRef.current !== reqId) return;
        updateOrganizeDownloadsSession({
          folderPath: res.folderPath,
          preview: res,
          errorMessage: null,
        });
      } catch (err) {
        if (previewSeqRef.current !== reqId) return;
        updateOrganizeDownloadsSession({
          preview: null,
          errorMessage: formatLocalizedError(err, messages),
        });
      } finally {
        if (previewSeqRef.current === reqId) {
          setLoading(false);
        }
      }
    },
    [messages, t.unknownFolderDefault, updateOrganizeDownloadsSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            if (busy || paths.length === 0) return;
            const folder = paths[0]!.trim();
            if (!folder) return;
            updateOrganizeDownloadsSession({
              folderPath: folder,
              lastExecution: null,
              errorMessage: null,
            });
            void runPreview(folder, state.namingMode, state.moveUnknownToFolder, state.mappings);
          },
        }),
      "f05-organize-downloads-drop",
    );
  }, [
    busy,
    runPreview,
    state.mappings,
    state.moveUnknownToFolder,
    state.namingMode,
    updateOrganizeDownloadsSession,
  ]);

  const handleChooseFolder = async () => {
    if (busy) return;
    const picked = await pickSingleDirectory({ title: t.pickFolderTitle });
    if (!picked) return;
    updateOrganizeDownloadsSession({
      folderPath: picked,
      lastExecution: null,
      errorMessage: null,
    });
    await runPreview(picked, state.namingMode, state.moveUnknownToFolder, state.mappings);
  };

  const handleNamingModeChange = (nextMode: OrganizeNamingMode) => {
    updateOrganizeDownloadsSession({ namingMode: nextMode });
    if (state.folderPath) {
      void runPreview(state.folderPath, nextMode, state.moveUnknownToFolder, state.mappings);
    }
  };

  const handleUnknownToggle = (checked: boolean) => {
    updateOrganizeDownloadsSession({ moveUnknownToFolder: checked });
    if (state.folderPath) {
      void runPreview(state.folderPath, state.namingMode, checked, state.mappings);
    }
  };

  const handleAddMapping = () => {
    const errKey = validateDomainMappingInput(newDomain, newSite);
    if (errKey) {
      setMappingError(t.mappingErrors[errKey]);
      return;
    }
    const normDomain = normalizeDomainRuleInput(newDomain);
    const cleanSite = newSite.trim();
    const existingIdx = state.mappings.findIndex(
      (m) => m.domain.toLowerCase() === normDomain.toLowerCase(),
    );
    const nextMappings = [...state.mappings];
    if (existingIdx >= 0) {
      nextMappings[existingIdx] = {
        ...nextMappings[existingIdx]!,
        domain: normDomain,
        siteName: cleanSite,
      };
    } else {
      nextMappings.unshift({
        id: `custom-${Date.now()}-${normDomain}`,
        domain: normDomain,
        siteName: cleanSite,
      });
    }
    setNewDomain("");
    setNewSite("");
    setMappingError(null);
    updateOrganizeDownloadsSession({ mappings: nextMappings });
    if (state.folderPath) {
      void runPreview(state.folderPath, state.namingMode, state.moveUnknownToFolder, nextMappings);
    }
  };

  const handleRemoveMapping = (id: string) => {
    const nextMappings = state.mappings.filter((m) => m.id !== id);
    updateOrganizeDownloadsSession({ mappings: nextMappings });
    if (state.folderPath) {
      void runPreview(state.folderPath, state.namingMode, state.moveUnknownToFolder, nextMappings);
    }
  };

  const handleResetMappings = () => {
    const defaults = DEFAULT_DOMAIN_MAPPINGS.map((m) => ({ ...m }));
    setMappingError(null);
    updateOrganizeDownloadsSession({ mappings: defaults });
    if (state.folderPath) {
      void runPreview(state.folderPath, state.namingMode, state.moveUnknownToFolder, defaults);
    }
  };

  const handleClear = () => {
    if (busy) return;
    setFilterMode("all");
    updateOrganizeDownloadsSession({
      folderPath: "",
      preview: null,
      lastExecution: null,
      errorMessage: null,
    });
  };

  const readyItems = useMemo(() => {
    if (!state.preview) return [];
    return state.preview.items.filter(
      (item) =>
        item.action === "move" && item.targetFolderName !== null && item.contentSha256 !== null,
    );
  }, [state.preview]);

  const filteredItems = useMemo(() => {
    if (!state.preview) return [];
    return state.preview.items.filter((item) => {
      switch (filterMode) {
        case "move":
          return item.action === "move";
        case "already":
          return item.action === "already_organized";
        case "stay":
          return item.action === "stay_in_place";
        case "conflict":
          return item.action === "skip_conflict";
        default:
          return true;
      }
    });
  }, [filterMode, state.preview]);

  const handleExecuteConfirmed = async () => {
    setConfirmOpen(false);
    if (!state.preview || readyItems.length === 0 || busy) return;
    setExecuting(true);
    try {
      const res = await executeOrganizeDownloads({
        folderPath: state.preview.folderPath,
        items: readyItems.map((item) => ({
          sourcePath: item.sourcePath,
          fileName: item.fileName,
          targetFolderName: item.targetFolderName!,
          expectedByteLength: item.byteLength,
          expectedModifiedMs: item.modifiedMs,
          expectedFileIdKey: item.fileIdKey,
          expectedSha256: item.contentSha256!,
        })),
      });
      updateOrganizeDownloadsSession({ lastExecution: res, errorMessage: null });
      // Immediately refresh preview so moved items appear as already organized
      await runPreview(
        state.preview.folderPath,
        state.namingMode,
        state.moveUnknownToFolder,
        state.mappings,
      );
    } catch (err) {
      updateOrganizeDownloadsSession({
        errorMessage: formatLocalizedError(err, messages),
      });
    } finally {
      setExecuting(false);
    }
  };

  const handleOpenFolder = async () => {
    const dir = state.lastExecution?.folderPath || state.preview?.folderPath || state.folderPath;
    if (!dir) return;
    try {
      await openLocalDirectory(dir);
    } catch (err) {
      updateOrganizeDownloadsSession({
        errorMessage: formatLocalizedError(err, messages),
      });
    }
  };

  return (
    <div className="org-dl-workspace">
      <section className={`org-dl-panel ${dropHover ? "is-drop-hover" : ""}`}>
        <div className="org-dl-row">
          <div
            className={`org-dl-path-box ${state.folderPath ? "" : "is-placeholder"}`}
            title={state.folderPath || undefined}
          >
            {state.folderPath || t.folderPlaceholder}
          </div>
          <div className="org-dl-group">
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={handleChooseFolder}
            >
              {t.chooseFolderBtn}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !state.folderPath}
              onClick={() =>
                void runPreview(
                  state.folderPath,
                  state.namingMode,
                  state.moveUnknownToFolder,
                  state.mappings,
                )
              }
            >
              {t.refreshBtn}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy || !state.folderPath}
              onClick={handleClear}
            >
              {t.clearBtn}
            </button>
          </div>
        </div>
        <p className="org-dl-hint">{t.privacyHint}</p>

        <div className="org-dl-row">
          <div className="org-dl-group">
            <label htmlFor="org-dl-naming-mode" style={{ fontSize: 12.5, fontWeight: 600 }}>
              {t.namingModeLabel}
            </label>
            <select
              id="org-dl-naming-mode"
              className="select-input"
              value={state.namingMode}
              disabled={busy}
              onChange={(e) => handleNamingModeChange(e.target.value as OrganizeNamingMode)}
            >
              <option value="site_alias">{t.namingSiteAlias}</option>
              <option value="domain_only">{t.namingDomainOnly}</option>
            </select>
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={state.moveUnknownToFolder}
              disabled={busy}
              onChange={(e) => handleUnknownToggle(e.target.checked)}
            />
            <span>{t.unknownToggleLabel}</span>
          </label>
        </div>
      </section>

      <details className="org-dl-mapping-details">
        <summary>{t.mappingSummary(state.mappings.length)}</summary>
        <div className="org-dl-mapping-body">
          <p className="org-dl-hint">{t.mappingRuleNote}</p>
          <div className="org-dl-mapping-add">
            <input
              type="text"
              className="text-input"
              placeholder={t.mappingDomainPlaceholder}
              aria-label={t.mappingDomainPlaceholder}
              value={newDomain}
              disabled={busy}
              onChange={(e) => setNewDomain(e.target.value)}
            />
            <input
              type="text"
              className="text-input"
              placeholder={t.mappingSitePlaceholder}
              aria-label={t.mappingSitePlaceholder}
              value={newSite}
              disabled={busy}
              onChange={(e) => setNewSite(e.target.value)}
            />
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={handleAddMapping}
            >
              {t.mappingAddBtn}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={handleResetMappings}
            >
              {t.mappingResetBtn}
            </button>
          </div>
          {mappingError && <div className="inline-banner is-warn">{mappingError}</div>}
          <div className="org-dl-mapping-list">
            {state.mappings.map((rule) => (
              <div key={rule.id} className="org-dl-mapping-item">
                <span>
                  <code className="org-dl-mono">{rule.domain}</code> →{" "}
                  <strong>{rule.siteName}</strong>
                </span>
                <button
                  type="button"
                  className="org-dl-remove-btn"
                  disabled={busy}
                  aria-label={t.removeRuleAria(rule.domain)}
                  onClick={() => handleRemoveMapping(rule.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      </details>

      {state.errorMessage && (
        <div className="inline-banner is-err" role="alert">
          {state.errorMessage}
        </div>
      )}

      {loading && (
        <div className="inline-banner" role="status">
          {t.loadingPreview}
        </div>
      )}
      {executing && (
        <div className="inline-banner" role="status">
          {t.executingLabel}
        </div>
      )}

      {state.preview && !state.preview.volumeSupportsAds && (
        <div className="inline-banner is-warn" role="status">
          {t.unsupportedFsWarn}
        </div>
      )}

      {state.lastExecution && (
        <section className="org-dl-panel">
          <div className="org-dl-row">
            <div className="org-dl-group">
              <strong>{t.execResultHeading}</strong>
              <span className="status-pill is-ok">
                {t.execSummary(
                  state.lastExecution.movedCount,
                  state.lastExecution.skippedCount,
                  state.lastExecution.failedCount,
                )}
              </span>
            </div>
            <button type="button" className="btn btn-secondary" onClick={handleOpenFolder}>
              {t.openFolderBtn}
            </button>
          </div>
          {state.lastExecution.outcomes.length > 0 && (
            <details>
              <summary style={{ cursor: "pointer", fontSize: 12.5 }}>
                {t.execDetailsSummary(state.lastExecution.outcomes.length)}
              </summary>
              <div className="org-dl-table-wrap" style={{ marginTop: 8 }}>
                <table className="org-dl-table">
                  <thead>
                    <tr>
                      <th>{t.colFile}</th>
                      <th>{t.colStatus}</th>
                      <th>{t.colTarget}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.lastExecution.outcomes.map((item, idx) => (
                      <tr key={`${item.sourcePath}-${idx}`}>
                        <td className="org-dl-mono">{item.fileName}</td>
                        <td>
                          <span
                            className={`status-pill ${
                              item.status === "moved"
                                ? "is-ok"
                                : item.status === "skipped"
                                  ? "is-warn"
                                  : "is-err"
                            }`}
                          >
                            {t.execOutcomeLabels[item.status]}
                          </span>
                          {item.reason && (
                            <span className="org-dl-hint" style={{ marginLeft: 8 }}>
                              {item.reason}
                            </span>
                          )}
                        </td>
                        <td className="org-dl-mono">{item.targetPath ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </section>
      )}

      {!state.preview ? (
        <section className="org-dl-panel">
          <div className="org-dl-empty">
            <strong>{t.emptyFolderTitle}</strong>
            <div>{t.emptyFolderBody}</div>
          </div>
        </section>
      ) : (
        <section className="org-dl-panel">
          <div className="org-dl-row">
            <div className="org-dl-group">
              <span className="status-pill is-ok">{t.badgeReady(state.preview.readyCount)}</span>
              <span className="status-pill">
                {t.badgeAlready(state.preview.alreadyOrganizedCount)}
              </span>
              <span className="status-pill is-warn">
                {t.badgeStay(state.preview.stayInPlaceCount)}
              </span>
              {state.preview.conflictCount > 0 && (
                <span className="status-pill is-err">
                  {t.badgeConflict(state.preview.conflictCount)}
                </span>
              )}
              {state.preview.nonImageCount > 0 && (
                <span className="status-pill">{t.badgeNonImage(state.preview.nonImageCount)}</span>
              )}
            </div>

            <div className="org-dl-group">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={handleOpenFolder}
              >
                {t.openFolderBtn}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy || readyItems.length === 0}
                onClick={() => setConfirmOpen(true)}
              >
                {t.executeBtn(readyItems.length)}
              </button>
            </div>
          </div>

          <div className="org-dl-group">
            {(
              [
                ["all", t.filterAll],
                ["move", t.filterMove],
                ["already", t.filterAlready],
                ["stay", t.filterStay],
                ["conflict", t.filterConflict],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`seg-btn ${filterMode === key ? "is-active" : ""}`}
                onClick={() => setFilterMode(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {state.preview.items.length === 0 ? (
            <div className="org-dl-empty">{t.emptyImagesBody}</div>
          ) : (
            <div className="org-dl-table-wrap">
              <table className="org-dl-table">
                <thead>
                  <tr>
                    <th>{t.colFile}</th>
                    <th>{t.colSource}</th>
                    <th>{t.colTarget}</th>
                    <th>{t.colStatus}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredItems.map((item) => (
                    <tr key={item.sourcePath}>
                      <td>
                        <div className="org-dl-mono">{item.fileName}</div>
                        <div className="org-dl-hint">{formatOrganizeBytes(item.byteLength)}</div>
                      </td>
                      <td>
                        {item.detectedDomain ? (
                          <div>
                            {item.mappedSiteName && <strong>{item.mappedSiteName} · </strong>}
                            <span className="org-dl-mono">{item.detectedDomain}</span>
                            {item.zoneId !== null && (
                              <span className="org-dl-hint"> (ZoneId={item.zoneId})</span>
                            )}
                          </div>
                        ) : (
                          <span className="org-dl-hint">{t.sourceUnknown}</span>
                        )}
                      </td>
                      <td className="org-dl-mono">{item.targetRelPath ?? t.targetUnchanged}</td>
                      <td>
                        <span className={statusPillClass(item.status)}>
                          {t.statusLabels[item.status]}
                        </span>
                        {item.reason && <div className="org-dl-hint">{item.reason}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title={t.confirmTitle}
        body={t.confirmBody(readyItems.length, state.preview?.folderPath ?? state.folderPath)}
        confirmLabel={t.confirmAccept}
        cancelLabel={t.confirmCancel}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void handleExecuteConfirmed()}
      />
    </div>
  );
}
