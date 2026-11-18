import { isFrontendShuttingDown, registerCancelableFrontendWorker } from "../../lib/shutdownGate";
import {
  convertCoordinateBatch,
  type BatchCoordinateConversionResult,
  type BatchCoordinateOptions,
} from "./coordinateEngine";
import type {
  CoordinateBatchWorkerRequest,
  CoordinateBatchWorkerResponse,
} from "./coordinateWorker";

export type CoordinateBatchRunOutcome =
  | { kind: "completed"; result: BatchCoordinateConversionResult }
  | { kind: "cancelled" }
  | { kind: "worker_error"; message: string };

export interface CoordinateWorkerLike {
  onmessage: ((ev: MessageEvent<CoordinateBatchWorkerResponse>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(msg: CoordinateBatchWorkerRequest): void;
  terminate(): void;
}

export class CancellableCoordinateBatchController {
  private seq = 0;
  private activeWorker: CoordinateWorkerLike | null = null;
  private activeSettle: ((outcome: CoordinateBatchRunOutcome) => void) | null = null;
  private unregisterShutdown: (() => void) | null = null;
  private readonly workerFactory: (() => CoordinateWorkerLike) | undefined;

  constructor(workerFactory?: () => CoordinateWorkerLike) {
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

  public runBatch(
    input: string,
    options: BatchCoordinateOptions,
  ): Promise<CoordinateBatchRunOutcome> {
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
          resolve({ kind: "completed", result: convertCoordinateBatch(input, options) });
        });
      });
    }

    return new Promise<CoordinateBatchRunOutcome>((resolve) => {
      let worker: CoordinateWorkerLike;
      try {
        worker = this.workerFactory
          ? this.workerFactory()
          : new Worker(new URL("./coordinateWorker.ts", import.meta.url), {
              type: "module",
            });
      } catch (err) {
        resolve({
          kind: "worker_error",
          message:
            err instanceof Error ? err.message : "Failed to initialize coordinate batch Worker.",
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

      worker.onmessage = (ev: MessageEvent<CoordinateBatchWorkerResponse>) => {
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
          message: ev.message || "Coordinate batch Worker execution error.",
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
