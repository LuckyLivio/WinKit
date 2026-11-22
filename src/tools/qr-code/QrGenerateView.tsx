import { Copy, Download, FileCode } from "lucide-react";
import { useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useI18n } from "../../i18n/I18nContext";
import { copyQrImage, saveQrImage } from "../../lib/qrBridge";
import { isTauriDesktop, parseBackendError, pickSaveFilePath } from "../../lib/tauriBridge";
import {
  DEFAULT_QR_STYLE,
  generateQr,
  pngFromQr,
  wifiPayload,
  type CorrectionLevel,
  type WifiInput,
  type WifiSecurity,
} from "./qrGenerator";
import "./qrGenerate.css";

const labels = {
  "zh-CN": {
    template: "内容类型",
    link: "链接",
    text: "文本",
    wifi: "Wi-Fi",
    ssid: "网络名 (SSID)",
    security: "安全类型",
    open: "开放网络",
    password: "密码",
    hidden: "隐藏网络",
    foreground: "前景色",
    background: "背景色",
    size: "尺寸 (px)",
    correction: "纠错级别",
    preview: "二维码预览",
    copy: "复制图片",
    png: "保存 PNG",
    svg: "导出 SVG",
    empty: "输入内容后预览二维码。",
    capacity: "内容超出当前纠错级别的二维码容量。请缩短内容或降低纠错级别。",
    sizeError: "请输入 64 至 2048 之间的整数，尺寸须能容纳全部模块及静区。",
    color: "请选择不同的前景色和背景色。",
    invalidLink: "请输入包含协议的完整链接。",
    copied: "图片已复制。",
    saved: "文件已保存。",
    failed: "输出失败。请检查剪贴板权限或目标文件后重试。",
    cancel: "取消",
  },
  "en-US": {
    template: "Content type",
    link: "Link",
    text: "Text",
    wifi: "Wi-Fi",
    ssid: "Network name (SSID)",
    security: "Security",
    open: "Open network",
    password: "Password",
    hidden: "Hidden network",
    foreground: "Foreground",
    background: "Background",
    size: "Size (px)",
    correction: "Error correction",
    preview: "QR code preview",
    copy: "Copy image",
    png: "Save PNG",
    svg: "Export SVG",
    empty: "Enter content to preview the QR code.",
    capacity:
      "This content exceeds QR capacity at this correction level. Shorten it or use a lower level.",
    sizeError: "Enter a whole number from 64 to 2048, large enough for the modules and quiet zone.",
    color: "Choose different foreground and background colors.",
    invalidLink: "Enter a full link including its scheme.",
    copied: "Image copied.",
    saved: "File saved.",
    failed: "Output failed. Check clipboard access or the destination file and try again.",
    cancel: "Cancel",
  },
};

type Format = "png" | "svg";
interface PendingSave {
  path: string;
  format: Format;
  data: Blob;
}

export function QrGenerateView() {
  const { locale, t } = useI18n();
  const words = labels[locale];
  const [template, setTemplate] = useState<"link" | "text" | "wifi">("link");
  const [link, setLink] = useState("");
  const [plainText, setPlainText] = useState("");
  const [wifi, setWifi] = useState<WifiInput>({
    ssid: "",
    security: "WPA",
    password: "",
    hidden: false,
  });
  const [style, setStyle] = useState(DEFAULT_QR_STYLE);
  const [sizeInput, setSizeInput] = useState(String(DEFAULT_QR_STYLE.size));
  const [notice, setNotice] = useState<"copied" | "saved" | "failed" | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingSave | null>(null);

  const result = useMemo(() => {
    let payload = plainText;
    if (template === "link") {
      payload = link.trim();
      if (payload && !URL.canParse(payload)) return { error: "invalidLink" as const };
    }
    if (template === "wifi") payload = wifiPayload(wifi);
    return generateQr(payload, { ...style, size: Number(sizeInput) });
  }, [link, plainText, sizeInput, style, template, wifi]);
  const image = "image" in result ? result.image : null;

  const writeFile = async (save: PendingSave, overwrite: boolean) => {
    try {
      await saveQrImage(save.path, save.format, save.data, overwrite);
      setNotice("saved");
    } catch (err) {
      if (!overwrite && parseBackendError(err).code === "TARGET_ALREADY_EXISTS") {
        setPending(save);
      } else {
        setNotice("failed");
      }
    }
  };

  const output = async (action: "copy" | Format) => {
    if (!image || busy || pending) return;
    setBusy(true);
    setNotice(null);
    try {
      const data =
        action === "svg"
          ? new Blob([image.svg], { type: "image/svg+xml" })
          : await pngFromQr(image);
      if (action === "copy") {
        await copyQrImage(data);
        setNotice("copied");
      } else if (isTauriDesktop()) {
        const path = await pickSaveFilePath({
          title: words[action],
          defaultPath: `QR.${action}`,
          filters: [{ name: action.toUpperCase(), extensions: [action] }],
        });
        if (path) await writeFile({ path, format: action, data }, false);
      } else {
        const url = URL.createObjectURL(data);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `QR.${action}`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      setNotice("failed");
    } finally {
      setBusy(false);
    }
  };

  const confirmSave = async () => {
    if (!pending || busy) return;
    setPending(null);
    setBusy(true);
    try {
      await writeFile(pending, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qr-generate">
      <fieldset
        className="pane qr-settings"
        disabled={busy || !!pending}
        onChange={() => setNotice(null)}
      >
        <div className="tool-toolbar-group segmented" role="group" aria-label={words.template}>
          {(["link", "text", "wifi"] as const).map((mode) => (
            <button
              type="button"
              key={mode}
              className={`segmented-btn${template === mode ? " is-selected" : ""}`}
              aria-pressed={template === mode}
              onClick={() => {
                setTemplate(mode);
                setNotice(null);
              }}
            >
              {words[mode]}
            </button>
          ))}
        </div>
        {template === "link" && (
          <label className="field-stack">
            {words.link}
            <input
              type="url"
              autoComplete="off"
              className="text-input"
              placeholder="https://…"
              value={link}
              onChange={(e) => setLink(e.target.value)}
            />
          </label>
        )}
        {template === "text" && (
          <label className="field-stack">
            {words.text}
            <textarea
              className="text-input qr-text"
              rows={5}
              value={plainText}
              onChange={(e) => setPlainText(e.target.value)}
            />
          </label>
        )}
        {template === "wifi" && (
          <>
            <label className="field-stack">
              {words.ssid}
              <input
                className="text-input"
                autoComplete="off"
                value={wifi.ssid}
                onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })}
              />
            </label>
            <label className="field-stack">
              {words.security}
              <select
                className="select-input"
                value={wifi.security}
                onChange={(e) => {
                  const security = e.target.value as WifiSecurity;
                  setWifi({
                    ...wifi,
                    security,
                    password: security === "nopass" ? "" : wifi.password,
                  });
                }}
              >
                <option value="WPA">WPA / WPA2</option>
                <option value="WEP">WEP</option>
                <option value="nopass">{words.open}</option>
              </select>
            </label>
            {wifi.security !== "nopass" && (
              <label className="field-stack">
                {words.password}
                <input
                  type="password"
                  autoComplete="off"
                  className="text-input"
                  value={wifi.password}
                  onChange={(e) => setWifi({ ...wifi, password: e.target.value })}
                />
              </label>
            )}
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={wifi.hidden}
                onChange={(e) => setWifi({ ...wifi, hidden: e.target.checked })}
              />
              {words.hidden}
            </label>
          </>
        )}
        <div className="qr-options">
          {(["foreground", "background"] as const).map((key) => (
            <label key={key} className="field-stack">
              {words[key]}
              <input
                type="color"
                value={style[key]}
                onChange={(e) => setStyle({ ...style, [key]: e.target.value })}
              />
            </label>
          ))}
          <label className="field-stack">
            {words.size}
            <input
              type="number"
              min="64"
              max="2048"
              step="1"
              className="text-input"
              value={sizeInput}
              onChange={(e) => setSizeInput(e.target.value)}
            />
          </label>
          <label className="field-stack">
            {words.correction}
            <select
              className="select-input"
              value={style.correction}
              onChange={(e) =>
                setStyle({ ...style, correction: e.target.value as CorrectionLevel })
              }
            >
              {["L", "M", "Q", "H"].map((level) => (
                <option key={level}>{level}</option>
              ))}
            </select>
          </label>
        </div>
      </fieldset>
      <section className="pane qr-output" aria-label={words.preview}>
        <div className="pane-header">
          <span className="pane-title">{words.preview}</span>
          {image && (
            <span className="field-hint">
              {image.size} × {image.size} px
            </span>
          )}
        </div>
        <div className="qr-preview">
          {image ? (
            <img
              alt={words.preview}
              src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(image.svg)}`}
            />
          ) : (
            "error" in result && (
              <p
                className={`status-banner${result.error === "empty" ? "" : " is-warn"}`}
                role={result.error === "empty" ? undefined : "alert"}
              >
                {words[result.error === "size" ? "sizeError" : result.error]}
              </p>
            )
          )}
        </div>
        <div className="tool-toolbar-group qr-actions">
          {(["copy", "png", "svg"] as const).map((action) => {
            const Icon = action === "copy" ? Copy : action === "png" ? Download : FileCode;
            return (
              <button
                type="button"
                key={action}
                className={action === "copy" ? "btn btn-primary" : "btn"}
                disabled={!image || busy || !!pending}
                onClick={() => void output(action)}
              >
                <Icon size={15} aria-hidden="true" />
                {words[action]}
              </button>
            );
          })}
        </div>
        {notice && (
          <p className={`status-banner ${notice === "failed" ? "is-err" : "is-ok"}`} role="status">
            {words[notice]}
          </p>
        )}
      </section>
      <ConfirmDialog
        open={!!pending}
        title={t.jsonTool.overwriteConfirmTitle}
        body={t.jsonTool.overwriteConfirmBody(pending?.path ?? "")}
        cancelLabel={words.cancel}
        confirmLabel={t.jsonTool.overwriteConfirmAccept}
        onCancel={() => setPending(null)}
        onConfirm={() => void confirmSave()}
      />
    </div>
  );
}
