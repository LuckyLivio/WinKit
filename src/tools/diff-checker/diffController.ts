import { isFrontendShuttingDown, registerCancelableFrontendWorker } from "../../lib/shutdownGate";
import { computeDiffResult, type DiffComputationResult, type DiffOptions } from "./diffEngine";
import type { DiffWorkerRequest, DiffWorkerResponse } from "./diffWorker";

export type DiffRunOutcome =
  | { kind: "completed"; result: DiffComputationResult }
  | { kind: "cancelled" }
  | { kind: "worker_error"; message: string };

export class CancellableDiffController {
  private seq = 0;
  private activeWorker: Worker | null = null;
  private activeSettle: ((outcome: DiffRunOutcome) => void) | null = null;
  private unregisterShutdown: (() => void) | null = null;

  public cancelCurrent(): void {
    this.seq += 1;
    if (this.unregisterShutdown) {
      const unreg = this.unregisterShutdown;
      this.unregisterShutdown = null;
      unreg();
    }
    if (this.activeWorker) {
      this.activeWorker.terminate();
      this.activeWorker = null;
    }
    if (this.activeSettle) {
      const settle = this.activeSettle;
      this.activeSettle = null;
      settle({ kind: "cancelled" });
    }
  }

  public dispose(): void {
    this.cancelCurrent();
  }

  public runDiff(params: {
    leftText: string;
    rightText: string;
    options: DiffOptions;
    leftLabel: string;
    rightLabel: string;
  }): Promise<DiffRunOutcome> {
    this.cancelCurrent();
    if (isFrontendShuttingDown()) {
      return Promise.resolve({ kind: "cancelled" });
    }

    const currentSeq = ++this.seq;

    if (typeof Worker === "undefined") {
      return new Promise((resolve) => {
        this.activeSettle = resolve;
        queueMicrotask(() => {
          if (currentSeq !== this.seq || isFrontendShuttingDown()) {
            return;
          }
          this.activeSettle = null;
          const result = computeDiffResult(
            params.leftText,
            params.rightText,
            params.options,
            params.leftLabel,
            params.rightLabel,
          );
          resolve({ kind: "completed", result });
        });
      });
    }

    return new Promise<DiffRunOutcome>((resolve) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./diffWorker.ts", import.meta.url), {
          type: "module",
        });
      } catch (err) {
        resolve({
          kind: "worker_error",
          message: err instanceof Error ? err.message : "Failed to initialize diff Worker.",
        });
        return;
      }

      this.activeWorker = worker;
      this.activeSettle = resolve;
      this.unregisterShutdown = registerCancelableFrontendWorker(() => {
        this.cancelCurrent();
      });

      const cleanup = () => {
        if (this.unregisterShutdown) {
          const unreg = this.unregisterShutdown;
          this.unregisterShutdown = null;
          unreg();
        }
        if (this.activeWorker === worker) {
          worker.terminate();
          this.activeWorker = null;
        }
        if (this.activeSettle === resolve) {
          this.activeSettle = null;
        }
      };

      worker.onmessage = (ev: MessageEvent<DiffWorkerResponse>) => {
        if (ev.data.seq !== currentSeq) {
          return;
        }
        cleanup();
        resolve({ kind: "completed", result: ev.data.result });
      };

      worker.onerror = (ev) => {
        if (currentSeq !== this.seq) {
          return;
        }
        cleanup();
        resolve({
          kind: "worker_error",
          message: ev.message || "Diff Worker execution error.",
        });
      };

      const req: DiffWorkerRequest = {
        seq: currentSeq,
        leftText: params.leftText,
        rightText: params.rightText,
        options: params.options,
        leftLabel: params.leftLabel,
        rightLabel: params.rightLabel,
      };
      worker.postMessage(req);
    });
  }
}
