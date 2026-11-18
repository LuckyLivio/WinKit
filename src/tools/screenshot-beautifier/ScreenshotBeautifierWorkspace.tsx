import { Download, Eraser, FolderOpen, ImagePlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type BeautifierAspect } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  exportBeautifiedImage,
  formatLocalizedError,
  inspectBeautifierSourceImage,
  parseBackendError,
  pickSaveFilePath,
  pickSingleFile,
  subscribeFileDrop,
  suggestSafeSiblingPath,
} from "../../lib/tauriBridge";
import { PRESET_SOLID_BACKGROUNDS, computeFrameLayout, normalizeHexColor } from "./layout";

export function ScreenshotBeautifierWorkspace() {
  const { locale, t } = useI18n();
  const { session, updateBeautifierSession } = useSessionStore();
  const {
    sourcePath,
    sourceFileName,
    previewDataUrl,
    sourceWidth,
    sourceHeight,
    backgroundColor,
    padding,
    cornerRadius,
    shadowStrength,
    aspectRatio,
    lastSavedMessage,
  } = session.beautifier;

  const stageHostRef = useRef<HTMLDivElement | null>(null);
  const [hostBounds, setHostBounds] = useState<{ w: number; h: number }>({ w: 640, h: 420 });
  const [colorDraft, setColorDraft] = useState(backgroundColor);
  const [dropHover, setDropHover] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pendingOverwritePath, setPendingOverwritePath] = useState<string | null>(null);

  useEffect(() => {
    setColorDraft(backgroundColor);
  }, [backgroundColor]);

  // Measure preview viewport so scaled px radii and shadows match exact layout ratios
  useEffect(() => {
    const el = stageHostRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 40 && rect.height > 40) {
        setHostBounds({ w: rect.width - 32, h: rect.height - 32 });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(() => {
    if (!sourceWidth || !sourceHeight) {
      return null;
    }
    return computeFrameLayout({
      sourceWidth,
      sourceHeight,
      padding,
      cornerRadius,
      shadowStrength,
      aspectRatio,
    });
  }, [sourceWidth, sourceHeight, padding, cornerRadius, shadowStrength, aspectRatio]);

  const previewScale = useMemo(() => {
    if (!layout) return 1;
    return Math.min(hostBounds.w / layout.canvasWidth, hostBounds.h / layout.canvasHeight, 1);
  }, [hostBounds, layout]);

  const loadImagePath = useCallback(
    async (filePath: string) => {
      setErrorText(null);
      setLoadingSource(true);
      try {
        const info = await inspectBeautifierSourceImage(filePath);
        updateBeautifierSession({
          sourcePath: info.path,
          sourceFileName: info.fileName,
          previewDataUrl: info.previewDataUrl,
          sourceWidth: info.width,
          sourceHeight: info.height,
          hasAlpha: info.hasAlpha,
          lastSavedMessage: null,
        });
      } catch (err) {
        setErrorText(formatLocalizedError(err, t));
      } finally {
        setLoadingSource(false);
      }
    },
    [t, updateBeautifierSession],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (hovering) => setDropHover(hovering),
          onDropPaths: (paths) => {
            const first = paths[0];
            if (first) {
              void loadImagePath(first);
            }
          },
        }),
      "beautifier-file-drop",
    );
  }, [loadImagePath]);

  const handleChooseImage = async () => {
    const chosen = await pickSingleFile({
      title: t.beautifierTool.selectImageBtn,
      filters: [{ name: "Images (PNG, JPEG)", extensions: ["png", "jpg", "jpeg"] }],
    });
    if (chosen) {
      await loadImagePath(chosen);
    }
  };

  const handleClearImage = () => {
    setErrorText(null);
    updateBeautifierSession({
      sourcePath: null,
      sourceFileName: null,
      previewDataUrl: null,
      sourceWidth: null,
      sourceHeight: null,
      hasAlpha: false,
      lastSavedMessage: null,
    });
  };

  const runExport = async (outputPath: string, overwrite: boolean) => {
    if (!sourcePath || !layout || layout.exceedsLimits) return;
    setErrorText(null);
    setExporting(true);
    try {
      const exported = await exportBeautifiedImage({
        inputPath: sourcePath,
        outputPath,
        backgroundHex: backgroundColor,
        padding,
        cornerRadius,
        shadowStrength,
        aspectRatio,
        overwrite,
      });
      updateBeautifierSession({
        lastSavedMessage: t.beautifierTool.exportedSuccess(
          exported.outputPath,
          exported.outputWidth,
          exported.outputHeight,
        ),
      });
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TARGET_ALREADY_EXISTS" && !overwrite) {
        setPendingOverwritePath(outputPath);
        return;
      }
      setErrorText(formatLocalizedError(err, t));
    } finally {
      setExporting(false);
    }
  };

  const handleExportClick = async () => {
    if (!sourcePath || !layout || layout.exceedsLimits) return;
    const defaultPath =
      (await suggestSafeSiblingPath(sourcePath, "_framed", "png")) ?? "screenshot_framed.png";
    const chosen = await pickSaveFilePath({
      title: t.beautifierTool.exportPngBtn,
      defaultPath,
      filters: [{ name: "PNG Image", extensions: ["png"] }],
    });
    if (chosen) {
      await runExport(chosen, false);
    }
  };

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn"
            disabled={loadingSource || exporting}
            onClick={handleChooseImage}
          >
            {sourcePath ? (
              <FolderOpen size={14} strokeWidth={1.75} aria-hidden="true" />
            ) : (
              <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
            )}
            <span>
              {sourcePath ? t.beautifierTool.replaceImageBtn : t.beautifierTool.selectImageBtn}
            </span>
          </button>

          {sourcePath && (
            <button type="button" className="btn" disabled={exporting} onClick={handleClearImage}>
              <Eraser size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{t.beautifierTool.clearImageBtn}</span>
            </button>
          )}
        </div>

        <div className="tool-toolbar-group">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!sourcePath || !layout || layout.exceedsLimits || exporting || loadingSource}
            onClick={handleExportClick}
          >
            <Download size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{exporting ? t.beautifierTool.exportingBtn : t.beautifierTool.exportPngBtn}</span>
          </button>
        </div>
      </div>

      <p className="field-hint">{t.beautifierTool.scopeNote}</p>

      {errorText && (
        <div className="status-banner is-err" role="alert">
          <span>{errorText}</span>
        </div>
      )}

      {layout?.exceedsLimits && (
        <div className="status-banner is-err" role="alert">
          <span>
            {t.errors.SIZE_LIMIT_EXCEEDED} ({layout.canvasWidth} × {layout.canvasHeight} px)
          </span>
        </div>
      )}

      {lastSavedMessage && !errorText && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{lastSavedMessage}</span>
        </div>
      )}

      <div className="beautifier-grid">
        {/* Left: Live Preview Stage */}
        <div className={`pane ${dropHover ? "is-drop-hover" : ""}`}>
          <div className="pane-header">
            <span className="pane-title">{t.beautifierTool.previewLabel}</span>
            {layout && sourceWidth && sourceHeight && (
              <span className="mono" style={{ fontSize: "11.5px", color: "var(--text-secondary)" }}>
                {t.beautifierTool.sourceSizeLabel}: {sourceWidth}×{sourceHeight} px ·{" "}
                {t.beautifierTool.outputSizeLabel}:{" "}
                <strong>
                  {layout.canvasWidth}×{layout.canvasHeight} px
                </strong>
              </span>
            )}
          </div>

          <div
            ref={stageHostRef}
            style={{
              flex: 1,
              minHeight: "320px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "16px",
              background: "var(--bg-subtle)",
              overflow: "hidden",
            }}
          >
            {!sourcePath || !previewDataUrl || !layout ? (
              <div className="empty-state" style={{ maxWidth: "420px" }}>
                <strong
                  style={{ display: "block", marginBottom: "6px", color: "var(--text-primary)" }}
                >
                  {t.beautifierTool.emptyTitle}
                </strong>
                <p style={{ margin: "0 0 12px", fontSize: "12.5px" }}>
                  {t.beautifierTool.emptyDesc}
                </p>
                <button type="button" className="btn btn-primary" onClick={handleChooseImage}>
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{t.beautifierTool.selectImageBtn}</span>
                </button>
                <p className="field-hint" style={{ marginTop: "12px" }}>
                  {t.beautifierTool.limitHint}
                </p>
              </div>
            ) : (
              <div
                data-testid="beautifier-preview-canvas"
                style={{
                  position: "relative",
                  width: `${Math.max(40, Math.round(layout.canvasWidth * previewScale))}px`,
                  height: `${Math.max(40, Math.round(layout.canvasHeight * previewScale))}px`,
                  backgroundColor,
                  borderRadius: "4px",
                  boxShadow: "var(--shadow-sm)",
                  overflow: "hidden",
                  flexShrink: 0,
                }}
              >
                <img
                  src={previewDataUrl}
                  alt={sourceFileName ?? "Screenshot preview"}
                  draggable={false}
                  style={{
                    position: "absolute",
                    left: `${Math.round(layout.imageX * previewScale)}px`,
                    top: `${Math.round(layout.imageY * previewScale)}px`,
                    width: `${Math.round(layout.imageWidth * previewScale)}px`,
                    height: `${Math.round(layout.imageHeight * previewScale)}px`,
                    borderRadius: `${(layout.effectiveRadius * previewScale).toFixed(1)}px`,
                    boxShadow:
                      layout.shadowOpacity > 0
                        ? `0px ${(layout.shadowOffsetY * previewScale).toFixed(1)}px ${(layout.shadowBlur * 2 * previewScale).toFixed(1)}px rgba(0, 0, 0, ${layout.shadowOpacity.toFixed(3)})`
                        : "none",
                    display: "block",
                  }}
                />
              </div>
            )}
          </div>

          <div
            style={{
              padding: "8px 12px",
              borderTop: "1px solid var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <p className="field-hint">{t.beautifierTool.noUpscaleNote}</p>
          </div>
        </div>

        {/* Right: Parameters Panel */}
        <div className="pane" style={{ padding: "16px", gap: "16px", overflowY: "auto" }}>
          {/* Aspect Ratio */}
          <div className="field-stack">
            <span className="field-label">{t.beautifierTool.aspectLabel}</span>
            <div className="segmented" role="group" aria-label={t.beautifierTool.aspectLabel}>
              {(
                [
                  ["original", t.beautifierTool.aspectOriginal],
                  ["1:1", t.beautifierTool.aspectSquare],
                  ["16:9", t.beautifierTool.aspectWide],
                ] as Array<[BeautifierAspect, string]>
              ).map(([ratio, label]) => (
                <button
                  key={ratio}
                  type="button"
                  style={{ flex: 1 }}
                  className={`segmented-btn ${aspectRatio === ratio ? "is-selected" : ""}`}
                  aria-pressed={aspectRatio === ratio}
                  onClick={() =>
                    updateBeautifierSession({ aspectRatio: ratio, lastSavedMessage: null })
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Solid Background Color */}
          <div className="field-stack">
            <span className="field-label">{t.beautifierTool.bgColorLabel}</span>
            <div className="swatch-grid" role="group" aria-label={t.beautifierTool.bgColorLabel}>
              {PRESET_SOLID_BACKGROUNDS.map((preset) => (
                <button
                  key={preset.hex}
                  type="button"
                  className="swatch-btn"
                  style={{ backgroundColor: preset.hex }}
                  aria-label={locale === "zh-CN" ? preset.labelZh : preset.labelEn}
                  aria-pressed={backgroundColor.toUpperCase() === preset.hex}
                  title={`${locale === "zh-CN" ? preset.labelZh : preset.labelEn} (${preset.hex})`}
                  onClick={() =>
                    updateBeautifierSession({
                      backgroundColor: preset.hex,
                      lastSavedMessage: null,
                    })
                  }
                />
              ))}
            </div>

            <div className="field-row" style={{ marginTop: "4px" }}>
              <label htmlFor="beautifier-color-picker" className="field-hint">
                {t.beautifierTool.customColorLabel}
              </label>
              <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                <input
                  id="beautifier-color-picker"
                  type="color"
                  value={backgroundColor}
                  onChange={(e) => {
                    const hex = e.target.value.toUpperCase();
                    updateBeautifierSession({ backgroundColor: hex, lastSavedMessage: null });
                  }}
                  style={{
                    width: "28px",
                    height: "28px",
                    padding: 0,
                    border: "1px solid var(--border-strong)",
                    borderRadius: "6px",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                />
                <input
                  type="text"
                  aria-label="HEX"
                  className="text-input mono"
                  style={{ width: "92px" }}
                  value={colorDraft}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setColorDraft(raw);
                    const valid = normalizeHexColor(raw);
                    if (valid) {
                      updateBeautifierSession({
                        backgroundColor: valid,
                        lastSavedMessage: null,
                      });
                    }
                  }}
                />
              </div>
            </div>
          </div>

          {/* Padding */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-padding" className="field-label">
                {t.beautifierTool.paddingLabel}
              </label>
              <span className="mono field-hint">{padding} px</span>
            </div>
            <input
              id="beautifier-padding"
              type="range"
              className="range-input"
              min={0}
              max={240}
              step={4}
              value={padding}
              onChange={(e) =>
                updateBeautifierSession({
                  padding: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>

          {/* Corner Radius */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-radius" className="field-label">
                {t.beautifierTool.radiusLabel}
              </label>
              <span className="mono field-hint">
                {layout ? layout.effectiveRadius : cornerRadius} px
              </span>
            </div>
            <input
              id="beautifier-radius"
              type="range"
              className="range-input"
              min={0}
              max={160}
              step={2}
              value={cornerRadius}
              onChange={(e) =>
                updateBeautifierSession({
                  cornerRadius: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>

          {/* Drop Shadow */}
          <div className="field-stack">
            <div className="field-row">
              <label htmlFor="beautifier-shadow" className="field-label">
                {t.beautifierTool.shadowLabel}
              </label>
              <span className="mono field-hint">{shadowStrength}%</span>
            </div>
            <input
              id="beautifier-shadow"
              type="range"
              className="range-input"
              min={0}
              max={100}
              step={2}
              value={shadowStrength}
              onChange={(e) =>
                updateBeautifierSession({
                  shadowStrength: Number(e.target.value),
                  lastSavedMessage: null,
                })
              }
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={pendingOverwritePath !== null}
        title={t.beautifierTool.overwriteConfirmTitle}
        body={t.beautifierTool.overwriteConfirmBody(pendingOverwritePath ?? "")}
        confirmLabel={t.beautifierTool.overwriteConfirmAccept}
        cancelLabel={t.beautifierTool.cancel}
        onCancel={() => setPendingOverwritePath(null)}
        onConfirm={async () => {
          const target = pendingOverwritePath;
          setPendingOverwritePath(null);
          if (target) {
            await runExport(target, true);
          }
        }}
      />
    </div>
  );
}
