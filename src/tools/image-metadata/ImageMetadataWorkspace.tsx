import { useCallback, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore } from "../../lib/sessionStore";
import { formatLocalizedError, inspectBatchImages } from "../../lib/tauriBridge";
import { ImageBatchShell } from "../image-batch/ImageBatchShell";
import {
  formatImageBytes,
  formatImageFormatLabel,
  formatSupportsMetadataStripping,
  mergeInspectedItems,
  type ImageMetadataFlags,
  type InspectedImageItem,
} from "../image-batch/imageBatchModel";

const copy = {
  "zh-CN": {
    emptyTitle: "选择或拖入图片开始批量清除元数据",
    emptyBody:
      "采用容器级无损清理（不重复有损编码），移除 JPEG、PNG、WebP 与经典 TIFF 中的 GPS 定位、相机型号、拍摄时间、EXIF、XMP、IPTC、注释及重复元数据段，写入前逐项复检。",
    preserveTitle: "默认保留（仅保留正常显示所需信息）",
    keepOrientation: "保留正确显示方向（仅保留单条 EXIF Orientation 标记）",
    keepColor: "保留色彩配置（ICC Profile / PNG sRGB·gAMA·cHRM）",
    scopeTitle: "容器级清理支持范围",
    scopeBody:
      "支持 JPEG、PNG、WebP 与经典 TIFF；自动清理重复元数据段并二次验证无残留。BigTIFF、SubIFD/RAW、HEIC、GIF、BMP 无法可靠容器清理时将逐项报错，绝不计为已清除。",
    detectedTitle: "已检测到的隐私元数据",
    noneDetected: "未检测到 GPS / 相机 / 时间 / XMP / IPTC / 注释等隐私元数据",
    unsupportedBanner:
      "当前格式不支持可靠容器级清理，批量执行时该文件将标记失败，绝不会误报为已清除。",
    duplicateBadge: (n: number) => `含 ${n} 处重复元数据段`,
    orientPill: (o: number) => `方向 Orientation=${o}`,
    iccPill: "含 ICC 色彩配置",
    executeBtn: (n: number) => (n > 0 ? `批量清除并导出 (${n} 张)` : "批量清除并导出"),
    cleanBadge: "无隐私元数据",
    unsupportedBadge: "格式不支持",
    tagLabels: {
      GPS: "GPS 位置",
      Camera: "相机/软件",
      DateTime: "拍摄时间",
      EXIF: "EXIF",
      XMP: "XMP",
      IPTC: "IPTC",
      Comments: "注释/文本",
    } as Record<string, string>,
  },
  "en-US": {
    emptyTitle: "Select or drop images to strip metadata cleanly",
    emptyBody:
      "Container-level lossless stripping (zero lossy pixel re-encoding) removes GPS, camera, timestamps, EXIF, XMP, IPTC, comments, and duplicate segments across JPEG, PNG, WebP, and classic TIFF with post-strip verification.",
    preserveTitle: "Preserved by default (display fidelity only)",
    keepOrientation: "Preserve display orientation (minimal Orientation-only tag)",
    keepColor: "Preserve color profile (ICC Profile / PNG sRGB·gAMA·cHRM)",
    scopeTitle: "Supported container scope",
    scopeBody:
      "Supports JPEG, PNG, WebP, and classic TIFF with duplicate-segment removal and verification. BigTIFF, SubIFD/RAW, HEIC, GIF, and BMP fail honestly per item and are never counted as cleaned.",
    detectedTitle: "Detected privacy metadata",
    noneDetected: "No GPS, camera, timestamp, XMP, IPTC, or comment metadata detected",
    unsupportedBanner:
      "This format is not supported for reliable container-level stripping and will report an error instead of being marked cleaned.",
    duplicateBadge: (n: number) => `${n} duplicate segment(s)`,
    orientPill: (o: number) => `Orientation=${o}`,
    iccPill: "ICC Profile",
    executeBtn: (n: number) => (n > 0 ? `Strip & Export ${n} Image(s)` : "Strip & Export"),
    cleanBadge: "Clean",
    unsupportedBadge: "Unsupported",
    tagLabels: {
      GPS: "GPS Location",
      Camera: "Camera / Software",
      DateTime: "Date / Time",
      EXIF: "EXIF",
      XMP: "XMP",
      IPTC: "IPTC",
      Comments: "Comments / Text",
    } as Record<string, string>,
  },
};

function hasPrivacyMetadata(flags: ImageMetadataFlags): boolean {
  return (
    flags.hasGps ||
    flags.hasCameraInfo ||
    flags.hasDatetime ||
    flags.hasExif ||
    flags.hasXmp ||
    flags.hasIptc ||
    flags.hasComments
  );
}

export function ImageMetadataWorkspace() {
  const { locale, t: messages } = useI18n();
  const t = copy[locale];
  const { session, updateImageMetadataSession, startImageMetadataBatch, cancelImageMetadataBatch } =
    useSessionStore();
  const state = session.imageMetadata;

  const [inspecting, setInspecting] = useState(false);
  const busy = state.status === "running";

  const handleAddPaths = useCallback(
    async (paths: string[]) => {
      setInspecting(true);
      try {
        const inspected = await inspectBatchImages(paths);
        updateImageMetadataSession((prev) => {
          const merged = mergeInspectedItems(prev.items, inspected.items);
          return {
            ...prev,
            items: merged,
            selectedPath: prev.selectedPath ?? merged[0]?.path ?? null,
            errorMessage: null,
          };
        });
      } catch (err) {
        updateImageMetadataSession({ errorMessage: formatLocalizedError(err, messages) });
      } finally {
        setInspecting(false);
      }
    },
    [messages, updateImageMetadataSession],
  );

  const handleExecute = () => {
    if (busy || state.items.length === 0 || !state.outputDir) return;
    void startImageMetadataBatch(
      {
        sourcePaths: state.items.map((i) => i.path),
        outputDir: state.outputDir,
        keepOrientation: state.keepOrientation,
        keepColorProfile: state.keepColorProfile,
      },
      (err) => formatLocalizedError(err, messages),
    );
  };

  const renderPreview = (item: InspectedImageItem | null) => {
    if (!item) return null;
    const supported = formatSupportsMetadataStripping(item.format);
    const flags = item.metadataFlags;
    const dirty = hasPrivacyMetadata(flags);

    return (
      <>
        <div className="img-batch-stage-header">
          <div className="img-batch-group">
            <strong style={{ fontSize: 13 }}>{item.fileName}</strong>
            <span className="status-pill">{formatImageFormatLabel(item.format)}</span>
            {!item.error && (
              <span className="status-pill">
                {item.displayWidth}×{item.displayHeight}
              </span>
            )}
            <span className="status-pill">{formatImageBytes(item.byteLength)}</span>
            {item.exifOrientation > 1 && (
              <span className="status-pill">{t.orientPill(item.exifOrientation)}</span>
            )}
            {item.hasIccProfile && <span className="status-pill">{t.iccPill}</span>}
          </div>
        </div>

        <div className="img-batch-stage-canvas">
          {item.error ? (
            <div className="img-batch-empty">
              <strong style={{ color: "var(--status-err)" }}>{item.error}</strong>
            </div>
          ) : item.thumbnailDataUrl ? (
            <img
              src={item.thumbnailDataUrl}
              alt={item.fileName}
              className="img-batch-preview-img"
            />
          ) : (
            <div className="img-batch-empty">{item.fileName}</div>
          )}
        </div>

        <div
          style={{
            borderTop: "1px solid var(--border-subtle)",
            padding: "10px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 6,
            background: "var(--bg-surface)",
          }}
        >
          <span className="img-batch-section-title">{t.detectedTitle}</span>
          {!supported || item.error ? (
            <span style={{ fontSize: 12, color: "var(--status-err)" }}>{t.unsupportedBanner}</span>
          ) : dirty ? (
            <div className="img-batch-group">
              {flags.tagHighlights.map((tag) => (
                <span
                  key={tag}
                  className={tag === "GPS" ? "status-pill is-err" : "status-pill is-warn"}
                >
                  {t.tagLabels[tag] ?? tag}
                </span>
              ))}
              {flags.duplicateSegmentCount > 0 && (
                <span className="status-pill is-err">
                  {t.duplicateBadge(flags.duplicateSegmentCount)}
                </span>
              )}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: "var(--status-ok)" }}>{t.noneDetected}</span>
          )}
        </div>
      </>
    );
  };

  const renderControls = () => (
    <>
      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.preserveTitle}</span>
        <label className="img-batch-checkbox-row">
          <input
            type="checkbox"
            checked={state.keepOrientation}
            disabled={busy}
            onChange={(e) => updateImageMetadataSession({ keepOrientation: e.target.checked })}
          />
          <span>{t.keepOrientation}</span>
        </label>
        <label className="img-batch-checkbox-row">
          <input
            type="checkbox"
            checked={state.keepColorProfile}
            disabled={busy}
            onChange={(e) => updateImageMetadataSession({ keepColorProfile: e.target.checked })}
          />
          <span>{t.keepColor}</span>
        </label>
      </div>

      <div className="img-batch-section">
        <span className="img-batch-section-title">{t.scopeTitle}</span>
        <p className="img-batch-hint" style={{ margin: 0 }}>
          {t.scopeBody}
        </p>
      </div>
    </>
  );

  return (
    <ImageBatchShell
      toolId="I09"
      items={state.items}
      selectedPath={state.selectedPath}
      outputDir={state.outputDir}
      busy={busy}
      inspecting={inspecting}
      liveProgress={state.liveProgress}
      lastReport={state.lastReport}
      errorMessage={state.errorMessage}
      emptyTitle={t.emptyTitle}
      emptyBody={t.emptyBody}
      executeLabel={t.executeBtn(state.items.length)}
      executeDisabled={state.items.length === 0 || !state.outputDir}
      onAddPaths={handleAddPaths}
      onSelectPath={(p) => updateImageMetadataSession({ selectedPath: p })}
      onRemovePath={(p) =>
        updateImageMetadataSession((prev) => {
          const next = prev.items.filter((i) => i.path !== p);
          return {
            ...prev,
            items: next,
            selectedPath: prev.selectedPath === p ? (next[0]?.path ?? null) : prev.selectedPath,
          };
        })
      }
      onClear={() =>
        updateImageMetadataSession({
          items: [],
          selectedPath: null,
          lastReport: null,
          errorMessage: null,
        })
      }
      onChooseOutputDir={(dir) => updateImageMetadataSession({ outputDir: dir })}
      onExecute={handleExecute}
      onCancel={() => void cancelImageMetadataBatch()}
      renderPreview={renderPreview}
      renderControls={renderControls}
      renderItemBadge={(item) => {
        if (item.error) {
          return null;
        }
        if (!formatSupportsMetadataStripping(item.format)) {
          return <span className="status-pill is-err">{t.unsupportedBadge}</span>;
        }
        if (hasPrivacyMetadata(item.metadataFlags)) {
          const summary = item.metadataFlags.tagHighlights.slice(0, 3).join("·");
          return (
            <span
              className={item.metadataFlags.hasGps ? "status-pill is-err" : "status-pill is-warn"}
            >
              {summary}
            </span>
          );
        }
        return <span className="status-pill is-ok">{t.cleanBadge}</span>;
      }}
    />
  );
}
