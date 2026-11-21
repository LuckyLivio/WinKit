import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import {
  copyQrText,
  openQrHttpUrl,
  readQrClipboardImage,
  readQrImageFile,
} from "../../lib/qrBridge";
import {
  bindDisposableListener,
  isTauriDesktop,
  parseBackendError,
  pickMultipleFiles,
  subscribeFileDrop,
} from "../../lib/tauriBridge";
import { decodeImage, QR_READ_LIMITS, type DecodeImageResult } from "./decodeImage";
import { isQrWebUrl, wifiPassword } from "./readActions";
import "./qrRead.css";

const labels = {
  "zh-CN": {
    choose: "选择图片",
    paste: "粘贴剪贴板图片",
    cancel: "取消识别",
    clear: "清空",
    clipboard: "剪贴板图片",
    pending: "等待识别",
    reading: "正在识别…",
    empty: "未找到二维码或条码。",
    hint: "拖入 PNG、JPEG 或 WebP 图片，或从剪贴板粘贴图片。",
    limits: (n: number) => `每批最多 ${n} 张，每张最多 16 MiB、1600 万像素。`,
    count: (n: number) => `请一次选择不超过 ${n} 张图片。`,
    copy: "复制内容",
    password: "复制 Wi-Fi 密码",
    open: "在浏览器打开",
    copied: "已复制",
    cancelled: "已取消识别。",
    actionError: "操作失败，请重试。",
    invalid: "图片已损坏或无法读取。",
    tooLarge: "图片超过大小或像素限制。",
    unsupported: "请选择 PNG、JPEG 或 WebP 图片。",
    timeout: "图片读取或识别超时。",
    failed: "无法读取或识别图片。",
    noClipboard: "无法读取剪贴板图片。",
    preview: "来源图片",
  },
  "en-US": {
    choose: "Choose images",
    paste: "Paste clipboard image",
    cancel: "Cancel scan",
    clear: "Clear",
    clipboard: "Clipboard image",
    pending: "Queued",
    reading: "Scanning…",
    empty: "No QR codes or barcodes found.",
    hint: "Drop PNG, JPEG or WebP images here, or paste an image from the clipboard.",
    limits: (n: number) => `Up to ${n} images per batch, 16 MiB and 16 million pixels per image.`,
    count: (n: number) => `Choose at most ${n} images at a time.`,
    copy: "Copy content",
    password: "Copy Wi-Fi password",
    open: "Open in browser",
    copied: "Copied",
    cancelled: "Scan cancelled.",
    actionError: "Action failed. Try again.",
    invalid: "The image is damaged or unreadable.",
    tooLarge: "The image exceeds the file or pixel limit.",
    unsupported: "Choose a PNG, JPEG or WebP image.",
    timeout: "Reading or scanning the image timed out.",
    failed: "Could not read or scan the image.",
    noClipboard: "Could not read a clipboard image.",
    preview: "Source image",
  },
};

type ReadFailure = "invalid" | "tooLarge" | "unsupported" | "timeout" | "failed" | "noClipboard";
type ReadRow = { name: string } & (
  | { status: "pending" | "reading" }
  | { status: "error"; reason: ReadFailure }
  | { status: "done"; result: DecodeImageResult }
);
interface Source {
  name: string;
  load: () => Promise<Blob>;
  clipboard?: boolean;
}

function failure(err: unknown, clipboard: boolean): ReadFailure {
  switch (parseBackendError(err).code) {
    case "SIZE_LIMIT_EXCEEDED":
    case "tooLarge":
      return "tooLarge";
    case "unsupported":
      return "unsupported";
    case "invalid":
    case "DECODE_FAILED":
      return "invalid";
    case "timeout":
      return "timeout";
    default:
      return clipboard ? "noClipboard" : "failed";
  }
}

// Native reads cannot be interrupted by the webview. Release the queue and ignore a late reply.
async function loadSource(source: Source, signal: AbortSignal): Promise<Blob> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  let abort!: () => void;
  let timer!: ReturnType<typeof setTimeout>;
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(
      () => reject({ code: "timeout", message: "Read timed out" }),
      QR_READ_LIMITS.timeoutMs,
    );
  });
  try {
    return await Promise.race([source.load(), interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

function Thumbnail({ blob, alt }: { blob: Blob; alt: string }) {
  const ref = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const el = ref.current;
    const url = URL.createObjectURL(blob);
    if (el) el.src = url;
    return () => {
      el?.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [blob]);
  return <img ref={ref} alt={alt} />;
}

export function QrReadView() {
  const { locale } = useI18n();
  const t = labels[locale];
  const [rows, setRows] = useState<ReadRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [notice, setNotice] = useState<"count" | "cancelled" | "copied" | "actionError" | null>(
    null,
  );
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const clear = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    setRows([]);
    setBusy(false);
    setNotice(null);
  }, []);

  const run = useCallback(
    async (sources: Source[]) => {
      if (sources.length === 0) return;
      clear();
      if (sources.length > QR_READ_LIMITS.files) {
        setNotice("count");
        return;
      }
      const batch = new AbortController();
      controller.current = batch;
      setBusy(true);
      setRows(sources.map(({ name }) => ({ name, status: "pending" })));
      function update(index: number, row: ReadRow) {
        if (!batch.signal.aborted)
          setRows((current) => current.map((prev, i) => (i === index ? row : prev)));
      }
      for (const [index, source] of sources.entries()) {
        if (batch.signal.aborted) return;
        update(index, { name: source.name, status: "reading" });
        try {
          const blob = await loadSource(source, batch.signal);
          if (batch.signal.aborted) return;
          const result = await decodeImage(blob, batch.signal);
          update(index, { name: source.name, status: "done", result });
        } catch (err) {
          update(index, {
            name: source.name,
            status: "error",
            reason: failure(err, !!source.clipboard),
          });
        }
      }
      if (!batch.signal.aborted) {
        controller.current = null;
        setBusy(false);
      }
    },
    [clear],
  );

  const readPaths = useCallback(
    (paths: string[]) => {
      if (paths.length > QR_READ_LIMITS.files) {
        clear();
        setNotice("count");
        return;
      }
      void run(
        paths.map((path) => ({
          name: path.split(/[\\/]/u).pop() || path,
          load: () => readQrImageFile(path),
        })),
      );
    },
    [clear, run],
  );

  function readFiles(files: FileList | null) {
    if (!files) return;
    if (files.length > QR_READ_LIMITS.files) {
      clear();
      setNotice("count");
      return;
    }
    void run(Array.from(files, (file) => ({ name: file.name, load: async () => file })));
  }

  useEffect(() => {
    let mounted = true;
    const unsubscribe = bindDisposableListener(
      () =>
        subscribeFileDrop({
          onHover: (value) => {
            if (mounted) setHovering(value);
          },
          onDropPaths: (paths) => {
            if (mounted) readPaths(paths);
          },
        }),
      "qr-image-drop",
    );
    return () => {
      mounted = false;
      generation.current++;
      controller.current?.abort();
      unsubscribe();
    };
  }, [readPaths]);

  async function choose() {
    if (!isTauriDesktop()) {
      input.current?.click();
      return;
    }
    const selection = ++generation.current;
    try {
      const paths = await pickMultipleFiles({
        title: t.choose,
        filters: [{ name: "PNG / JPEG / WebP", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (selection === generation.current) readPaths(paths);
    } catch {
      if (selection === generation.current) setNotice("actionError");
    }
  }

  async function act(action: () => Promise<void>, copied = false) {
    const selection = generation.current;
    setNotice(null);
    try {
      await action();
      if (copied && selection === generation.current) setNotice("copied");
    } catch {
      if (selection === generation.current) setNotice("actionError");
    }
  }

  return (
    <section
      className="qr-reader"
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (!isTauriDesktop()) readFiles(event.dataTransfer.files);
      }}
    >
      <div className="tool-toolbar">
        <div className="tool-toolbar-group">
          <button type="button" className="btn btn-primary" onClick={() => void choose()}>
            {t.choose}
          </button>
          <input
            type="file"
            hidden
            multiple
            accept="image/png,image/jpeg,image/webp"
            ref={input}
            onChange={(event) => {
              readFiles(event.currentTarget.files);
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className="btn"
            onClick={() =>
              void run([{ name: t.clipboard, load: readQrClipboardImage, clipboard: true }])
            }
          >
            {t.paste}
          </button>
          {busy ? (
            <button
              type="button"
              className="btn"
              onClick={() => {
                clear();
                setNotice("cancelled");
              }}
            >
              {t.cancel}
            </button>
          ) : (
            rows.length > 0 && (
              <button type="button" className="btn" onClick={clear}>
                {t.clear}
              </button>
            )
          )}
        </div>
      </div>
      <div className={`pane${hovering ? " is-drop-hover" : ""}`} style={{ padding: "12px" }}>
        {t.hint} <span className="field-hint">{t.limits(QR_READ_LIMITS.files)}</span>
      </div>
      {notice && (
        <div className="status-banner" role="status">
          {notice === "count" ? t.count(QR_READ_LIMITS.files) : t[notice]}
        </div>
      )}
      {rows.map((row, index) => (
        <section className="pane" key={index} aria-label={row.name}>
          <div className="pane-header">
            <strong className="qr-source-name" dir="auto">
              {row.name}
            </strong>
            {row.status === "done" && <span className="badge">{row.result.codes.length}</span>}
          </div>
          {row.status === "done" ? (
            <div className="qr-source">
              <Thumbnail blob={row.result.thumbnail} alt={`${t.preview} · ${row.name}`} />
              <div>
                {row.result.codes.length === 0
                  ? t.empty
                  : row.result.codes.map((code, codeIndex) => {
                      const password = wifiPassword(code.text);
                      return (
                        <div key={codeIndex} className="qr-code-result">
                          <strong>{code.format}</strong>
                          <pre className="qr-code-content" dir="auto">
                            {code.text}
                          </pre>
                          <div className="tool-toolbar-group">
                            <button
                              type="button"
                              className="btn"
                              onClick={() => void act(() => copyQrText(code.text), true)}
                            >
                              {t.copy}
                            </button>
                            {password !== null && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => void act(() => copyQrText(password), true)}
                              >
                                {t.password}
                              </button>
                            )}
                            {isQrWebUrl(code.text) && (
                              <button
                                type="button"
                                className="btn"
                                onClick={() => void act(() => openQrHttpUrl(code.text))}
                              >
                                {t.open}
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
              </div>
            </div>
          ) : (
            <p style={{ margin: "10px 12px" }} role="status">
              {row.status === "error" ? t[row.reason] : t[row.status]}
            </p>
          )}
        </section>
      ))}
    </section>
  );
}
