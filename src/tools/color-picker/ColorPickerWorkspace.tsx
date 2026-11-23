import {
  ArrowLeftRight,
  Check,
  ClipboardPaste,
  Copy,
  ImagePlus,
  Palette,
  Pipette,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { useSessionStore, type ColorHistoryItem } from "../../lib/sessionStore";
import {
  bindDisposableListener,
  extractImagePalette,
  formatLocalizedError,
  loadFileAsImageAsset,
  parseBackendError,
  pickScreenColor,
  pickSingleFile,
  readClipboardImageAsAsset,
  subscribeFileDrop,
  writeSystemClipboardText,
} from "../../lib/tauriBridge";
import { IMAGE_FILE_DIALOG_EXTENSIONS } from "../image-batch/imageBatchModel";
import {
  alphaToByte,
  evaluateWcagContrast,
  formatAllColorOutputs,
  formatCssHex,
  formatRgbHex6,
  formatWinUiXamlHex,
  normalizeColor,
  parseColorInput,
  type Hex8Interpretation,
  type RgbaColor,
} from "./colorEngine";
import "./colorPicker.css";

const MAX_HISTORY_ITEMS = 20;

const copy = {
  "zh-CN": {
    activeTitle: "屏幕取色与手动输入",
    pickScreenBtn: "屏幕取色",
    pickingScreenBtn: "等待取色（Esc 取消）...",
    screenHint:
      "取色时自动隐藏本窗口并显示放大镜：点击或按 Enter 确认，方向键按 1 px 微调，Esc 取消。屏幕取色读取合成后的显示 RGB，无法反推原窗口透明度。",
    manualPlaceholder: "输入 #RRGGBB / #RRGGBBAA / rgb() / hsl() / oklch()",
    hex8ModeCss: "CSS #RRGGBBAA",
    hex8ModeXaml: "XAML #AARRGGBB",
    alphaLabel: "不透明度 Alpha",
    sampleMeta: (x: number, y: number, scale: number) =>
      `上次屏幕取色：物理坐标 (${x}, ${y}) · ${scale}% DPI · 合成显示 sRGB`,
    pickCancelled: "已取消屏幕取色。",
    invalidColorInput: "无法识别该颜色格式，请输入有效的 HEX、RGB、HSL 或 OKLCH。",
    historyTitle: (n: number) => `最近取色历史 (${n}/${MAX_HISTORY_ITEMS})`,
    clearHistory: "清空历史",
    emptyHistory:
      "点击「屏幕取色」或输入颜色后，将自动记录最近 20 个颜色（仅保存在本次会话内存）。",
    formatsTitle: "一键复制格式",
    copyBtn: "复制",
    copiedBtn: "已复制",
    fmtHexSubRgb: "不透明 #RRGGBB",
    fmtHexSubCss: "CSS 顺序 #RRGGBBAA",
    fmtXamlSub: "Alpha 在前 #AARRGGBB",
    fmtCssSub: "透明色为 #RRGGBBAA",
    fmtCsharpSub: "FromArgb(A, R, G, B)",
    tailwindExactLabel: "精确任意值",
    tailwindApproxLabel: "最近命名色",
    badgeApprox: "近似",
    badgeExact: "精确匹配",
    paletteTitle: "图片色板提取",
    openImageBtn: "选择图片",
    pasteImageBtn: "粘贴图片",
    maxColorsLabel: "目标色数",
    paletteEmpty:
      "选择、粘贴或拖入图片，离线提取 5–8 个代表色（自动排除全透明像素，色数不足时仅展示有效色）。",
    paletteMeta: (shown: number, distinct: number, excludedAlpha: number) =>
      `提取 ${shown} 色（原图有效色 ${distinct} 种${excludedAlpha > 0 ? `，已排除 ${excludedAlpha.toLocaleString()} 个全透明像素` : ""}）`,
    paletteAllTransparent: "该图片全部像素均为完全透明 (alpha = 0)，无有效不透明色可提取。",
    setFgShort: "前景",
    setBgShort: "背景",
    contrastTitle: "WCAG 2.x 对比度检查",
    fgLabel: "前景色（文字）",
    bgLabel: "背景色",
    useActiveFg: "用当前色",
    useActiveBg: "用当前色",
    swapBtn: "互换",
    compositedNote: (effHex: string, bgHex: string, pct: number) =>
      `半透明前景 (${pct}%) 已先与背景 ${bgHex} 合成，实际计算前景色为 ${effHex}`,
    unroundedNote: (precise: string) => `精确未舍入比值 ${precise}（AA / AAA 按精确值判定）`,
    normalAA: "正文 AA (≥ 4.5:1)",
    normalAAA: "正文 AAA (≥ 7.0:1)",
    largeAA: "大字 AA (≥ 3.0:1)",
    largeAAA: "大字 AAA (≥ 4.5:1)",
    pass: "通过",
    fail: "未通过",
    sampleLargeText: "大号标题示例 Large Heading 18pt Bold",
    sampleNormalText: "正文阅读对比度示例：清晰可读的桌面工具排版 Normal body text 14px.",
  },
  "en-US": {
    activeTitle: "Screen Picker & Color Input",
    pickScreenBtn: "Pick from Screen",
    pickingScreenBtn: "Picking (Esc to cancel)...",
    screenHint:
      "Hides WinKit and opens a native pixel magnifier: click or Enter confirms, Arrow keys nudge 1 px, Esc cancels. Screen sampling reads composited display RGB (cannot infer original window alpha).",
    manualPlaceholder: "Enter #RRGGBB / #RRGGBBAA / rgb() / hsl() / oklch()",
    hex8ModeCss: "CSS #RRGGBBAA",
    hex8ModeXaml: "XAML #AARRGGBB",
    alphaLabel: "Opacity (Alpha)",
    sampleMeta: (x: number, y: number, scale: number) =>
      `Last screen sample: physical (${x}, ${y}) · ${scale}% DPI · composited sRGB`,
    pickCancelled: "Screen color picking cancelled.",
    invalidColorInput: "Unrecognized color value. Enter valid HEX, RGB, HSL, or OKLCH.",
    historyTitle: (n: number) => `Recent Colors (${n}/${MAX_HISTORY_ITEMS})`,
    clearHistory: "Clear History",
    emptyHistory: "Picked or edited colors are stored here (up to 20 items, session memory only).",
    formatsTitle: "One-Click Copy Formats",
    copyBtn: "Copy",
    copiedBtn: "Copied",
    fmtHexSubRgb: "Opaque #RRGGBB",
    fmtHexSubCss: "CSS order #RRGGBBAA",
    fmtXamlSub: "Alpha-first #AARRGGBB",
    fmtCssSub: "Uses #RRGGBBAA when translucent",
    fmtCsharpSub: "FromArgb(A, R, G, B)",
    tailwindExactLabel: "Exact arbitrary",
    tailwindApproxLabel: "Nearest named",
    badgeApprox: "Approx.",
    badgeExact: "Exact",
    paletteTitle: "Image Palette Extractor",
    openImageBtn: "Open Image",
    pasteImageBtn: "Paste Image",
    maxColorsLabel: "Swatches",
    paletteEmpty:
      "Open, paste, or drop an image to extract 5–8 representative colors offline (fully transparent pixels excluded; fewer distinct colors show only valid swatches).",
    paletteMeta: (shown: number, distinct: number, excludedAlpha: number) =>
      `${shown} swatch(es) (${distinct} distinct opaque color(s)${excludedAlpha > 0 ? `, excluded ${excludedAlpha.toLocaleString()} transparent px` : ""})`,
    paletteAllTransparent: "All pixels in this image are fully transparent (alpha = 0).",
    setFgShort: "Set FG",
    setBgShort: "Set BG",
    contrastTitle: "WCAG 2.x Contrast Checker",
    fgLabel: "Foreground (Text)",
    bgLabel: "Background",
    useActiveFg: "Use Active",
    useActiveBg: "Use Active",
    swapBtn: "Swap",
    compositedNote: (effHex: string, bgHex: string, pct: number) =>
      `Translucent foreground (${pct}%) composited over ${bgHex} → effective foreground ${effHex}`,
    unroundedNote: (precise: string) =>
      `Exact unrounded ratio ${precise} (AA/AAA judged on unrounded value)`,
    normalAA: "Normal AA (≥ 4.5:1)",
    normalAAA: "Normal AAA (≥ 7.0:1)",
    largeAA: "Large AA (≥ 3.0:1)",
    largeAAA: "Large AAA (≥ 4.5:1)",
    pass: "Pass",
    fail: "Fail",
    sampleLargeText: "Large Heading 18pt Bold · 大号标题示例",
    sampleNormalText: "Normal body text 14px readability check · 正文对比度预览",
  },
} as const;

function pushHistory(list: ColorHistoryItem[], color: RgbaColor): ColorHistoryItem[] {
  const norm = normalizeColor(color);
  const hexLabel = formatCssHex(norm);
  const filtered = list.filter((item) => item.hexLabel !== hexLabel);
  const entry: ColorHistoryItem = {
    id: `c-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    color: norm,
    hexLabel,
  };
  return [entry, ...filtered].slice(0, MAX_HISTORY_ITEMS);
}

function rgbaCssString(c: RgbaColor): string {
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${c.a})`;
}

export function ColorPickerWorkspace() {
  const { locale, t } = useI18n();
  const c = copy[locale];
  const { session, updateColorPickerSession } = useSessionStore();
  const st = session.colorPicker;

  const [picking, setPicking] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [dropHover, setDropHover] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const outputs = useMemo(() => formatAllColorOutputs(st.activeColor), [st.activeColor]);
  const contrast = useMemo(
    () => evaluateWcagContrast(st.contrastFg, st.contrastBg),
    [st.contrastFg, st.contrastBg],
  );

  const handleCopy = useCallback(
    async (key: string, value: string) => {
      try {
        await writeSystemClipboardText(value);
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((cur) => (cur === key ? null : cur));
        }, 1500);
      } catch (err) {
        setErrorMsg(formatLocalizedError(err, t));
      }
    },
    [t],
  );

  const applyActiveColor = useCallback(
    (nextColor: RgbaColor, recordHistory: boolean, customInput?: string) => {
      const norm = normalizeColor(nextColor);
      const formatted =
        customInput ??
        (st.hex8Order === "xaml_argb" && alphaToByte(norm.a) < 255
          ? formatWinUiXamlHex(norm)
          : formatCssHex(norm));
      updateColorPickerSession((prev) => ({
        ...prev,
        activeColor: norm,
        manualInput: formatted,
        history: recordHistory ? pushHistory(prev.history, norm) : prev.history,
      }));
    },
    [st.hex8Order, updateColorPickerSession],
  );

  const handlePickFromScreen = async () => {
    if (picking) return;
    setErrorMsg(null);
    setStatusMsg(null);
    setPicking(true);
    try {
      const sample = await pickScreenColor({ hideMainWindow: true });
      const next: RgbaColor = { r: sample.r, g: sample.g, b: sample.b, a: 1 };
      updateColorPickerSession((prev) => ({
        ...prev,
        activeColor: next,
        manualInput: sample.hex,
        lastSample: sample,
        history: pushHistory(prev.history, next),
      }));
      setStatusMsg(c.sampleMeta(sample.physicalX, sample.physicalY, sample.scalePercent));
    } catch (err) {
      const parsed = parseBackendError(err);
      if (parsed.code === "TASK_CANCELLED") {
        setStatusMsg(c.pickCancelled);
      } else {
        setErrorMsg(formatLocalizedError(err, t));
      }
    } finally {
      setPicking(false);
    }
  };

  const handleManualInputChange = (val: string) => {
    setErrorMsg(null);
    const parsed = parseColorInput(val, st.hex8Order);
    if (parsed) {
      updateColorPickerSession((prev) => ({
        ...prev,
        manualInput: val,
        activeColor: parsed,
      }));
    } else {
      updateColorPickerSession({ manualInput: val });
    }
  };

  const handleManualInputCommit = () => {
    const parsed = parseColorInput(st.manualInput, st.hex8Order);
    if (!parsed) {
      setErrorMsg(c.invalidColorInput);
      return;
    }
    setErrorMsg(null);
    applyActiveColor(parsed, true);
  };

  const handleHex8OrderChange = (mode: Hex8Interpretation) => {
    const parsed = parseColorInput(st.manualInput, mode);
    updateColorPickerSession((prev) => ({
      ...prev,
      hex8Order: mode,
      activeColor: parsed ?? prev.activeColor,
      manualInput:
        parsed === null
          ? mode === "xaml_argb" && alphaToByte(prev.activeColor.a) < 255
            ? formatWinUiXamlHex(prev.activeColor)
            : formatCssHex(prev.activeColor)
          : prev.manualInput,
    }));
  };

  const runPaletteFromFile = useCallback(
    async (filePath: string, maxColors = st.paletteMaxColors) => {
      setErrorMsg(null);
      setExtracting(true);
      try {
        const asset = await loadFileAsImageAsset(filePath);
        const result = await extractImagePalette({ assetId: asset.assetId, maxColors });
        updateColorPickerSession({
          paletteImageName: asset.label,
          paletteImagePath: filePath,
          paletteImageAssetId: asset.assetId,
          paletteImagePreviewUrl: asset.dataUrl,
          paletteMaxColors: maxColors,
          paletteResult: result,
        });
      } catch (err) {
        setErrorMsg(formatLocalizedError(err, t));
      } finally {
        setExtracting(false);
      }
    },
    [st.paletteMaxColors, t, updateColorPickerSession],
  );

  const handlePickPaletteFile = async () => {
    const picked = await pickSingleFile({
      title: c.openImageBtn,
      filters: [{ name: "Images", extensions: IMAGE_FILE_DIALOG_EXTENSIONS }],
    });
    if (picked) {
      await runPaletteFromFile(picked);
    }
  };

  const handlePastePaletteImage = async () => {
    setErrorMsg(null);
    setExtracting(true);
    try {
      const asset = await readClipboardImageAsAsset();
      const result = await extractImagePalette({
        assetId: asset.assetId,
        maxColors: st.paletteMaxColors,
      });
      updateColorPickerSession({
        paletteImageName: asset.label || "clipboard.png",
        paletteImagePath: null,
        paletteImageAssetId: asset.assetId,
        paletteImagePreviewUrl: asset.dataUrl,
        paletteResult: result,
      });
    } catch (err) {
      setErrorMsg(formatLocalizedError(err, t));
    } finally {
      setExtracting(false);
    }
  };

  const handleChangeMaxColors = async (nextCount: number) => {
    updateColorPickerSession({ paletteMaxColors: nextCount });
    if (!st.paletteImageAssetId && !st.paletteImagePath) return;
    setExtracting(true);
    setErrorMsg(null);
    try {
      const result = await extractImagePalette({
        assetId: st.paletteImageAssetId,
        path: st.paletteImageAssetId ? null : st.paletteImagePath,
        maxColors: nextCount,
      });
      updateColorPickerSession({ paletteResult: result, paletteMaxColors: nextCount });
    } catch (err) {
      setErrorMsg(formatLocalizedError(err, t));
    } finally {
      setExtracting(false);
    }
  };

  // Drag & drop an image directly onto I10 to extract its palette
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: setDropHover,
          onDropPaths: (paths) => {
            if (paths.length > 0 && paths[0]) {
              void runPaletteFromFile(paths[0]);
            }
          },
        }),
      "i10-palette-drop",
    );
  }, [runPaletteFromFile]);

  const setContrastFg = (color: RgbaColor, input?: string) => {
    const norm = normalizeColor(color);
    updateColorPickerSession({
      contrastFg: norm,
      contrastFgInput: input ?? formatCssHex(norm),
    });
  };

  const setContrastBg = (color: RgbaColor, input?: string) => {
    const norm = normalizeColor(color);
    updateColorPickerSession({
      contrastBg: norm,
      contrastBgInput: input ?? formatCssHex(norm),
    });
  };

  const alphaPct = Math.round(st.activeColor.a * 100);
  const fgAlphaPct = Math.round(st.contrastFg.a * 100);

  return (
    <div className="color-picker-shell">
      {errorMsg && (
        <div className="status-banner is-err" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}
      {statusMsg && !errorMsg && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{statusMsg}</span>
        </div>
      )}

      <div className="color-picker-grid">
        {/* LEFT COLUMN: Screen Picker + Input + History + Image Palette */}
        <div className="color-picker-col">
          {/* Active Color & Screen Sampler */}
          <section className="cp-card">
            <div className="cp-card-head">
              <h2 className="cp-card-title">{c.activeTitle}</h2>
              <button
                type="button"
                className="btn btn-primary"
                data-testid="i10-pick-screen-btn"
                disabled={picking}
                onClick={() => void handlePickFromScreen()}
              >
                <Pipette size={14} strokeWidth={1.8} aria-hidden="true" />
                <span>{picking ? c.pickingScreenBtn : c.pickScreenBtn}</span>
              </button>
            </div>

            <div className="cp-row" style={{ alignItems: "flex-start" }}>
              <div
                className="cp-checker-swatch cp-hero-swatch"
                title={outputs.hex}
                aria-label={outputs.hex}
              >
                <div
                  className="cp-checker-fill"
                  style={{ backgroundColor: rgbaCssString(st.activeColor) }}
                />
              </div>

              <div className="cp-hero-controls">
                <div className="cp-input-row">
                  <input
                    type="color"
                    className="cp-native-color"
                    aria-label="Color wheel"
                    value={formatRgbHex6(st.activeColor)}
                    onChange={(e) => {
                      const p = parseColorInput(e.target.value, "css_rgba");
                      if (p) applyActiveColor({ ...p, a: st.activeColor.a }, true);
                    }}
                  />
                  <input
                    type="text"
                    className="cp-text-input"
                    data-testid="i10-manual-input"
                    value={st.manualInput}
                    placeholder={c.manualPlaceholder}
                    aria-label={c.manualPlaceholder}
                    onChange={(e) => handleManualInputChange(e.target.value)}
                    onBlur={handleManualInputCommit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleManualInputCommit();
                    }}
                  />
                </div>

                <div className="cp-alpha-row">
                  <span>
                    {c.alphaLabel}: <strong className="mono">{alphaPct}%</strong> (
                    <span className="mono">{alphaToByte(st.activeColor.a)}/255</span>)
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={alphaPct}
                    aria-label={c.alphaLabel}
                    onChange={(e) => {
                      const nextA = Number(e.target.value) / 100;
                      applyActiveColor({ ...st.activeColor, a: nextA }, false);
                    }}
                    onMouseUp={() => applyActiveColor(st.activeColor, true)}
                  />
                </div>

                <div className="segmented" role="group" aria-label="8-digit HEX alpha order">
                  <button
                    type="button"
                    className={`segmented-btn ${st.hex8Order === "css_rgba" ? "is-selected" : ""}`}
                    onClick={() => handleHex8OrderChange("css_rgba")}
                  >
                    {c.hex8ModeCss}
                  </button>
                  <button
                    type="button"
                    className={`segmented-btn ${st.hex8Order === "xaml_argb" ? "is-selected" : ""}`}
                    onClick={() => handleHex8OrderChange("xaml_argb")}
                  >
                    {c.hex8ModeXaml}
                  </button>
                </div>
              </div>
            </div>

            {st.lastSample && (
              <p className="cp-note mono">
                {c.sampleMeta(
                  st.lastSample.physicalX,
                  st.lastSample.physicalY,
                  st.lastSample.scalePercent,
                )}
              </p>
            )}
            <p className="cp-note">{c.screenHint}</p>
          </section>

          {/* Recent 20 History */}
          <section className="cp-card">
            <div className="cp-card-head">
              <h2 className="cp-card-title">{c.historyTitle(st.history.length)}</h2>
              {st.history.length > 0 && (
                <button
                  type="button"
                  className="btn"
                  data-testid="i10-clear-history-btn"
                  onClick={() => updateColorPickerSession({ history: [] })}
                >
                  <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.clearHistory}</span>
                </button>
              )}
            </div>

            {st.history.length === 0 ? (
              <p className="cp-note">{c.emptyHistory}</p>
            ) : (
              <div className="cp-history-grid" data-testid="i10-history-list">
                {st.history.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="cp-history-chip"
                    onClick={() => applyActiveColor(item.color, false)}
                  >
                    <span className="cp-checker-swatch cp-history-dot">
                      <span
                        className="cp-checker-fill"
                        style={{ backgroundColor: rgbaCssString(item.color) }}
                      />
                    </span>
                    <span>{item.hexLabel}</span>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* Image Palette Extractor */}
          <section className="cp-card">
            <div className="cp-card-head">
              <h2 className="cp-card-title">
                <Palette
                  size={14}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  style={{ verticalAlign: "-2px", marginRight: 5 }}
                />
                {c.paletteTitle}
              </h2>
              <div className="cp-row" style={{ gap: 5 }}>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {c.maxColorsLabel}
                </span>
                <div className="segmented" role="group" aria-label={c.maxColorsLabel}>
                  {[5, 6, 7, 8].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`segmented-btn ${st.paletteMaxColors === n ? "is-selected" : ""}`}
                      disabled={extracting}
                      onClick={() => void handleChangeMaxColors(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className={`cp-palette-drop ${dropHover ? "is-drop-hover" : ""}`}>
              <div className="cp-row">
                <button
                  type="button"
                  className="btn"
                  disabled={extracting}
                  onClick={() => void handlePickPaletteFile()}
                >
                  <ImagePlus size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.openImageBtn}</span>
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={extracting}
                  onClick={() => void handlePastePaletteImage()}
                >
                  <ClipboardPaste size={14} strokeWidth={1.75} aria-hidden="true" />
                  <span>{c.pasteImageBtn}</span>
                </button>
              </div>

              {st.paletteResult ? (
                <>
                  <div className="cp-palette-preview-bar">
                    {st.paletteImagePreviewUrl && (
                      <img src={st.paletteImagePreviewUrl} alt="" className="cp-palette-thumb" />
                    )}
                    <div style={{ minWidth: 0 }}>
                      {st.paletteImageName && (
                        <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                          {st.paletteImageName}{" "}
                          <span className="mono" style={{ fontWeight: 400, fontSize: 11.5 }}>
                            ({st.paletteResult.width}×{st.paletteResult.height})
                          </span>
                        </div>
                      )}
                      <p className="cp-note">
                        {st.paletteResult.swatches.length === 0
                          ? c.paletteAllTransparent
                          : c.paletteMeta(
                              st.paletteResult.swatches.length,
                              st.paletteResult.distinctColorCount,
                              st.paletteResult.excludedTransparentPixels,
                            )}
                      </p>
                    </div>
                  </div>

                  {st.paletteResult.swatches.length > 0 && (
                    <div className="cp-palette-grid" data-testid="i10-palette-swatches">
                      {st.paletteResult.swatches.map((sw) => {
                        const swColor: RgbaColor = { r: sw.r, g: sw.g, b: sw.b, a: 1 };
                        return (
                          <div key={sw.hex} className="cp-swatch-card">
                            <div
                              className="cp-swatch-bar"
                              style={{ backgroundColor: sw.hex }}
                              title={sw.hex}
                              onClick={() => applyActiveColor(swColor, true)}
                            />
                            <div className="cp-swatch-meta">
                              <span>{sw.hex}</span>
                              <span style={{ color: "var(--text-secondary)" }}>
                                {sw.sharePercent}%
                              </span>
                            </div>
                            <div className="cp-swatch-actions">
                              <button
                                type="button"
                                className="cp-mini-btn"
                                onClick={() => void handleCopy(`pal-${sw.hex}`, sw.hex)}
                              >
                                {copiedKey === `pal-${sw.hex}` ? c.copiedBtn : c.copyBtn}
                              </button>
                              <button
                                type="button"
                                className="cp-mini-btn"
                                onClick={() => setContrastFg(swColor, sw.hex)}
                              >
                                {c.setFgShort}
                              </button>
                              <button
                                type="button"
                                className="cp-mini-btn"
                                onClick={() => setContrastBg(swColor, sw.hex)}
                              >
                                {c.setBgShort}
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              ) : (
                <p className="cp-note">{c.paletteEmpty}</p>
              )}
            </div>
          </section>
        </div>

        {/* RIGHT COLUMN: 8 Copyable Formats + WCAG 2.x Contrast Checker */}
        <div className="color-picker-col">
          {/* One-Click Copy Formats */}
          <section className="cp-card">
            <div className="cp-card-head">
              <h2 className="cp-card-title">{c.formatsTitle}</h2>
            </div>

            <div className="cp-formats-list" data-testid="i10-formats-list">
              {(
                [
                  [
                    "hex",
                    "HEX",
                    outputs.hexNote === "css_rrggbbaa" ? c.fmtHexSubCss : c.fmtHexSubRgb,
                    outputs.hex,
                  ],
                  ["rgb", "RGB", "", outputs.rgb],
                  ["hsl", "HSL", "", outputs.hsl],
                  ["oklch", "OKLCH", "Perceptual", outputs.oklch],
                  ["css", "CSS", c.fmtCssSub, outputs.css],
                  ["xaml", "WinUI / XAML", c.fmtXamlSub, outputs.winuiXaml],
                  ["csharp", "C#", c.fmtCsharpSub, outputs.csharp],
                ] as const
              ).map(([key, label, sub, val]) => (
                <div key={key} className="cp-format-row">
                  <div className="cp-format-label">
                    <span>{label}</span>
                    {sub && <span className="cp-format-sub">{sub}</span>}
                  </div>
                  <code className="cp-format-val" data-testid={`i10-fmt-${key}`} title={val}>
                    {val}
                  </code>
                  <button
                    type="button"
                    className="btn"
                    style={{ height: 26, padding: "0 8px", fontSize: 11.5 }}
                    onClick={() => void handleCopy(key, val)}
                  >
                    {copiedKey === key ? (
                      <Check size={12.5} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Copy size={12.5} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    <span>{copiedKey === key ? c.copiedBtn : c.copyBtn}</span>
                  </button>
                </div>
              ))}

              {/* Tailwind: Exact Arbitrary + Nearest Named (clearly marked Approx.) */}
              <div className="cp-tailwind-dual">
                <div className="cp-tailwind-line">
                  <div className="cp-row" style={{ gap: 6 }}>
                    <strong style={{ fontSize: 12 }}>Tailwind</strong>
                    <span className="cp-format-sub">{c.tailwindExactLabel}</span>
                    <code className="mono" style={{ fontSize: 12 }} data-testid="i10-fmt-tw-exact">
                      {outputs.tailwindExact}
                    </code>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    style={{ height: 25, padding: "0 8px", fontSize: 11.5 }}
                    onClick={() => void handleCopy("tw-exact", outputs.tailwindExact)}
                  >
                    {copiedKey === "tw-exact" ? (
                      <Check size={12} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    <span>{copiedKey === "tw-exact" ? c.copiedBtn : c.copyBtn}</span>
                  </button>
                </div>

                <div className="cp-tailwind-line">
                  <div className="cp-row" style={{ gap: 6 }}>
                    <span className="cp-format-sub">{c.tailwindApproxLabel}</span>
                    <span
                      style={{
                        display: "inline-block",
                        width: 12,
                        height: 12,
                        borderRadius: 3,
                        backgroundColor: outputs.tailwindNearest.hex,
                        border: "1px solid var(--border-strong)",
                      }}
                      aria-hidden="true"
                    />
                    <code className="mono" style={{ fontSize: 12 }} data-testid="i10-fmt-tw-named">
                      {outputs.tailwindNearest.className}
                    </code>
                    <span className="cp-format-sub mono">({outputs.tailwindNearest.hex})</span>
                    <span
                      className={
                        outputs.tailwindNearest.exactMatch ? "cp-tag-exact" : "cp-tag-approx"
                      }
                    >
                      {outputs.tailwindNearest.exactMatch ? c.badgeExact : c.badgeApprox}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    style={{ height: 25, padding: "0 8px", fontSize: 11.5 }}
                    onClick={() => void handleCopy("tw-named", outputs.tailwindNearest.className)}
                  >
                    {copiedKey === "tw-named" ? (
                      <Check size={12} strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Copy size={12} strokeWidth={1.8} aria-hidden="true" />
                    )}
                    <span>{copiedKey === "tw-named" ? c.copiedBtn : c.copyBtn}</span>
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* WCAG 2.x Contrast Checker */}
          <section className="cp-card">
            <div className="cp-card-head">
              <h2 className="cp-card-title">{c.contrastTitle}</h2>
              <div className="cp-row" style={{ gap: 6 }}>
                <button type="button" className="btn" onClick={() => setContrastFg(st.activeColor)}>
                  {c.useActiveFg} → {c.setFgShort}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setContrastBg({ ...st.activeColor, a: 1 })}
                >
                  {c.useActiveBg} → {c.setBgShort}
                </button>
              </div>
            </div>

            <div className="cp-contrast-inputs">
              <div className="cp-contrast-slot">
                <label style={{ fontSize: 12, fontWeight: 600 }}>{c.fgLabel}</label>
                <div className="cp-input-row">
                  <input
                    type="color"
                    className="cp-native-color"
                    aria-label={c.fgLabel}
                    value={formatRgbHex6(st.contrastFg)}
                    onChange={(e) => {
                      const p = parseColorInput(e.target.value, "css_rgba");
                      if (p) setContrastFg({ ...p, a: st.contrastFg.a });
                    }}
                  />
                  <input
                    type="text"
                    className="cp-text-input"
                    data-testid="i10-fg-input"
                    value={st.contrastFgInput}
                    aria-label={`${c.fgLabel} input`}
                    onChange={(e) => {
                      const val = e.target.value;
                      const p = parseColorInput(val, "css_rgba");
                      updateColorPickerSession({
                        contrastFgInput: val,
                        ...(p ? { contrastFg: p } : {}),
                      });
                    }}
                  />
                </div>
                <div className="cp-alpha-row">
                  <span>
                    Alpha <strong className="mono">{fgAlphaPct}%</strong>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={fgAlphaPct}
                    aria-label="Foreground alpha"
                    onChange={(e) =>
                      setContrastFg({ ...st.contrastFg, a: Number(e.target.value) / 100 })
                    }
                  />
                </div>
              </div>

              <button
                type="button"
                className="btn"
                style={{ alignSelf: "center", marginTop: 14 }}
                aria-label={c.swapBtn}
                title={c.swapBtn}
                onClick={() => {
                  const prevFg = st.contrastFg;
                  const prevBg = st.contrastBg;
                  updateColorPickerSession({
                    contrastFg: prevBg,
                    contrastFgInput: formatCssHex(prevBg),
                    contrastBg: { ...prevFg, a: 1 },
                    contrastBgInput: formatRgbHex6(prevFg),
                  });
                }}
              >
                <ArrowLeftRight size={14} strokeWidth={1.8} aria-hidden="true" />
              </button>

              <div className="cp-contrast-slot">
                <label style={{ fontSize: 12, fontWeight: 600 }}>{c.bgLabel}</label>
                <div className="cp-input-row">
                  <input
                    type="color"
                    className="cp-native-color"
                    aria-label={c.bgLabel}
                    value={formatRgbHex6(st.contrastBg)}
                    onChange={(e) => {
                      const p = parseColorInput(e.target.value, "css_rgba");
                      if (p) setContrastBg({ ...p, a: 1 });
                    }}
                  />
                  <input
                    type="text"
                    className="cp-text-input"
                    data-testid="i10-bg-input"
                    value={st.contrastBgInput}
                    aria-label={`${c.bgLabel} input`}
                    onChange={(e) => {
                      const val = e.target.value;
                      const p = parseColorInput(val, "css_rgba");
                      updateColorPickerSession({
                        contrastBgInput: val,
                        ...(p ? { contrastBg: { ...p, a: 1 } } : {}),
                      });
                    }}
                  />
                </div>
              </div>
            </div>

            {contrast.foregroundWasComposited && (
              <p className="cp-note" data-testid="i10-composited-note">
                {c.compositedNote(
                  contrast.compositedForegroundHex,
                  contrast.compositedBackgroundHex,
                  fgAlphaPct,
                )}
              </p>
            )}

            <div className="cp-contrast-hero">
              <div>
                <div className="cp-ratio-big" data-testid="i10-contrast-ratio">
                  {contrast.displayRatio}
                </div>
                <div className="cp-note mono">{c.unroundedNote(contrast.preciseRatio)}</div>
              </div>
            </div>

            <div className="cp-wcag-grid" data-testid="i10-wcag-grid">
              {(
                [
                  ["aa-normal", c.normalAA, contrast.aaNormal],
                  ["aaa-normal", c.normalAAA, contrast.aaaNormal],
                  ["aa-large", c.largeAA, contrast.aaLarge],
                  ["aaa-large", c.largeAAA, contrast.aaaLarge],
                ] as const
              ).map(([id, label, passed]) => (
                <div
                  key={id}
                  data-testid={`i10-wcag-${id}`}
                  className={`cp-wcag-badge ${passed ? "is-pass" : "is-fail"}`}
                >
                  <span>{label}</span>
                  <strong>{passed ? c.pass : c.fail}</strong>
                </div>
              ))}
            </div>

            <div
              className="cp-contrast-preview"
              style={{
                backgroundColor: contrast.compositedBackgroundHex,
                color: contrast.compositedForegroundHex,
              }}
            >
              <div style={{ fontSize: 18, fontWeight: 700 }}>{c.sampleLargeText}</div>
              <div style={{ fontSize: 14, lineHeight: 1.5 }}>{c.sampleNormalText}</div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
