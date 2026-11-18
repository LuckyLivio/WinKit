import { isFrontendShuttingDown, registerCancelableFrontendWorker } from "../../lib/shutdownGate";
import {
  convertTabularData,
  type CsvJsonOptions,
  type TabularConversionResult,
} from "./csvJsonEngine";
import type { TabularWorkerRequest, TabularWorkerResponse } from "./tabularWorker";

export type TabularRunOutcome =
  | { kind: "completed"; result: TabularConversionResult }
  | { kind: "cancelled" }
  | { kind: "worker_error"; message: string };

export interface TabularWorkerLike {
  onmessage: ((ev: MessageEvent<TabularWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(msg: TabularWorkerRequest): void;
  terminate(): void;
}

export class CancellableTabularController {
  private seq = 0;
  private activeWorker: TabularWorkerLike | null = null;
  private activeSettle: ((outcome: TabularRunOutcome) => void) | null = null;
  private unregisterShutdown: (() => void) | null = null;
  private readonly workerFactory: (() => TabularWorkerLike) | undefined;

  constructor(workerFactory?: () => TabularWorkerLike) {
    this.workerFactory = workerFactory;
  }

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

  public runConversion(input: string, options: CsvJsonOptions): Promise<TabularRunOutcome> {
    this.cancelCurrent();
    if (isFrontendShuttingDown()) {
      return Promise.resolve({ kind: "cancelled" });
    }

    const currentSeq = ++this.seq;

    if (!this.workerFactory && typeof Worker === "undefined") {
      return new Promise((resolve) => {
        this.activeSettle = resolve;
        queueMicrotask(() => {
          if (currentSeq !== this.seq || isFrontendShuttingDown()) {
            return;
          }
          this.activeSettle = null;
          resolve({ kind: "completed", result: convertTabularData(input, options) });
        });
      });
    }

    return new Promise<TabularRunOutcome>((resolve) => {
      let worker: TabularWorkerLike;
      try {
        worker = this.workerFactory
          ? this.workerFactory()
          : new Worker(new URL("./tabularWorker.ts", import.meta.url), {
              type: "module",
            });
      } catch (err) {
        resolve({
          kind: "worker_error",
          message: err instanceof Error ? err.message : "Failed to initialize tabular Worker.",
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

      worker.onmessage = (ev: MessageEvent<TabularWorkerResponse>) => {
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
          message: ev.message || "Tabular Worker execution error.",
        });
      };

      worker.postMessage({
        seq: currentSeq,
        input,
        options,
      });
    });
  }
}
