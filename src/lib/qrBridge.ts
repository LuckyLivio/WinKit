import { invoke } from "@tauri-apps/api/core";
import { assertFrontendNotShuttingDown } from "./shutdownGate";
import { cancelBackendTask, isTauriDesktop } from "./tauriBridge";

const maxFileBytes = 16 * 1024 * 1024;

function checkSize(blob: Blob) {
  if (!blob.size || blob.size > maxFileBytes) {
    throw { code: "SIZE_LIMIT_EXCEEDED", message: "Image must be between 1 byte and 16 MiB." };
  }
}

function blobBase64(data: Blob): Promise<string> {
  checkSize(data);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read image data."));
    reader.onload = () => resolve(String(reader.result).split(",")[1]!);
    reader.readAsDataURL(data);
  });
}

export async function readQrImageFile(path: string, signal?: AbortSignal): Promise<Blob> {
  assertFrontendNotShuttingDown();
  signal?.throwIfAborted();
  const taskId = `qr-read-${crypto.randomUUID()}`;
  const cancel = () => {
    void cancelBackendTask(taskId).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const data = await invoke<ArrayBuffer>("qr_read_image_file", { path, taskId });
    signal?.throwIfAborted();
    const [first] = new Uint8Array(data, 0, 1);
    const mime = first === 0x89 ? "image/png" : first === 0xff ? "image/jpeg" : "image/webp";
    return new Blob([data], { type: mime });
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export async function readQrClipboardImage(): Promise<Blob> {
  assertFrontendNotShuttingDown();
  if (isTauriDesktop() && navigator.userAgent.includes("Windows")) {
    const data = await invoke<ArrayBuffer>("qr_read_clipboard_image");
    return new Blob([data], { type: "image/png" });
  }
  for (const item of await navigator.clipboard.read()) {
    const type = item.types.find((t) => ["image/png", "image/jpeg", "image/webp"].includes(t));
    if (type) {
      const blob = await item.getType(type);
      checkSize(blob);
      return blob;
    }
  }
  throw { code: "DECODE_FAILED", message: "No supported clipboard image." };
}

export async function copyQrText(text: string): Promise<void> {
  assertFrontendNotShuttingDown();
  if (isTauriDesktop()) return invoke("qr_copy_text", { text });
  await navigator.clipboard.writeText(text);
}

export async function copyQrImage(png: Blob): Promise<void> {
  assertFrontendNotShuttingDown();
  checkSize(png);
  if (isTauriDesktop()) return invoke("qr_copy_image", { data: await blobBase64(png) });
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export async function saveQrImage(
  path: string,
  format: "png" | "svg",
  data: Blob,
  overwrite: boolean,
): Promise<void> {
  assertFrontendNotShuttingDown();
  await invoke("qr_save_image", { path, format, data: await blobBase64(data), overwrite });
}

export async function openQrHttpUrl(raw: string): Promise<void> {
  assertFrontendNotShuttingDown();
  const url = new URL(raw);
  if (
    !/^https?:$/.test(url.protocol) ||
    !url.hostname ||
    Array.from(raw).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("Only HTTP and HTTPS links can be opened.");
  }
  if (isTauriDesktop()) return invoke("qr_open_http_url", { url: url.href });
  window.open(url.href, "_blank", "noopener,noreferrer");
}
