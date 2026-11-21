import { isFrontendShuttingDown, registerCancelableFrontendWorker } from "../../lib/shutdownGate";
import {
  DecodeImageError,
  QR_READ_LIMITS,
  type DecodeImageResult,
  type DecodeResponse,
} from "./decodeFormat";

export { DecodeImageError, QR_READ_LIMITS } from "./decodeFormat";
export type { DecodeImageResult, DecodedCode } from "./decodeFormat";

export async function decodeImage(file: Blob, signal: AbortSignal): Promise<DecodeImageResult> {
  const aborted = () => new DOMException("Aborted", "AbortError");
  if (signal.aborted || isFrontendShuttingDown()) throw aborted();
  if (file.size > QR_READ_LIMITS.bytes) throw new DecodeImageError("tooLarge");

  const worker = new Worker(new URL("./decodeWorker.ts", import.meta.url), { type: "module" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: () => void = () => {};
  let unregister: (() => void) | undefined;
  try {
    return await new Promise<DecodeImageResult>((resolve, reject) => {
      cancel = () => reject(aborted());
      signal.addEventListener("abort", cancel, { once: true });
      unregister = registerCancelableFrontendWorker(cancel);
      timer = setTimeout(() => reject(new DecodeImageError("timeout")), QR_READ_LIMITS.timeoutMs);
      worker.onmessage = ({ data }: MessageEvent<DecodeResponse>) => {
        if ("error" in data) reject(new DecodeImageError(data.error));
        else resolve(data.result);
      };
      worker.onerror = (event) => {
        event.preventDefault();
        reject(new DecodeImageError("failed"));
      };
      worker.onmessageerror = () => reject(new DecodeImageError("failed"));
      worker.postMessage(file);
    });
  } finally {
    worker.terminate();
    worker.onmessage = null;
    signal.removeEventListener("abort", cancel);
    unregister?.();
    clearTimeout(timer);
  }
}
