import { isFrontendShuttingDown, registerCancelableFrontendWorker } from "../../lib/shutdownGate";
import {
  DEFAULT_REGEX_TIMEOUT_MS,
  type RegexExecutionRequest,
  type RegexExecutionResult,
} from "./regexCore";
import type { RegexWorkerMessageIn, RegexWorkerMessageOut } from "./regexWorker";

export interface RegexWorkerLike {
  onmessage: ((ev: MessageEvent<RegexWorkerMessageOut>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  postMessage(message: RegexWorkerMessageIn): void;
  terminate(): void;
}

export type RegexControllerOutcome =
  | { kind: "completed"; result: RegexExecutionResult }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "cancelled" }
  | { kind: "worker_error"; message: string };

/**
 * Enforces true preemptive Web Worker execution for ECMAScript RegExp evaluation:
 * - Never executes user RegExp on the main UI thread.
 * - Maintains an external main-thread timer (`timeoutMs`, default 2000ms) that calls
 *   `worker.terminate()` on timeout so catastrophic backtracking actually stops consuming CPU.
 * - Terminates superseded Workers immediately when inputs change, on unmount, or on window shutdown,
 *   using monotonic sequence numbers so stale results can never overwrite newer state.
 */
export class PreemptiveRegexController {
  private seq = 0;
  private activeWorker: RegexWorkerLike | null = null;
  private activeTimer: ReturnType<typeof setTimeout> | null = null;
  private activeSettle: ((outcome: RegexControllerOutcome) => void) | null = null;
  private unregisterShutdown: (() => void) | null = null;
  private readonly createWorker: () => RegexWorkerLike;
  private readonly timeoutMs: number;

  constructor(options?: { timeoutMs?: number; workerFactory?: () => RegexWorkerLike }) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_REGEX_TIMEOUT_MS;
    this.createWorker =
      options?.workerFactory ??
      (() =>
        new Worker(new URL("./regexWorker.ts", import.meta.url), {
          type: "module",
        }));
  }

  public cancelCurrent(): void {
    this.seq += 1;
    if (this.activeTimer !== null) {
      clearTimeout(this.activeTimer);
      this.activeTimer = null;
    }
    if (this.unregisterShutdown) {
      const unreg = this.unregisterShutdown;
      this.unregisterShutdown = null;
      unreg();
    }
    if (this.activeWorker) {
      const w = this.activeWorker;
      this.activeWorker = null;
      w.terminate();
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

  public evaluate(request: RegexExecutionRequest): Promise<RegexControllerOutcome> {
    this.cancelCurrent();

    if (isFrontendShuttingDown()) {
      return Promise.resolve({ kind: "cancelled" });
    }

    if (request.pattern.length === 0) {
      return Promise.resolve({
        kind: "completed",
        result: { status: "empty_pattern" },
      });
    }

    const currentSeq = ++this.seq;

    return new Promise<RegexControllerOutcome>((resolve) => {
      let worker: RegexWorkerLike;
      try {
        worker = this.createWorker();
      } catch (err) {
        resolve({
          kind: "worker_error",
          message:
            err instanceof Error ? err.message : "Unable to spawn dedicated RegExp Web Worker.",
        });
        return;
      }

      this.activeWorker = worker;
      this.activeSettle = resolve;
      this.unregisterShutdown = registerCancelableFrontendWorker(() => {
        this.cancelCurrent();
      });

      const cleanupHandles = (terminateWorker: boolean) => {
        if (this.activeTimer !== null) {
          clearTimeout(this.activeTimer);
          this.activeTimer = null;
        }
        if (this.unregisterShutdown) {
          const unreg = this.unregisterShutdown;
          this.unregisterShutdown = null;
          unreg();
        }
        if (this.activeWorker === worker) {
          this.activeWorker = null;
          if (terminateWorker) {
            worker.terminate();
          }
        }
        if (this.activeSettle === resolve) {
          this.activeSettle = null;
        }
      };

      // External main-thread watchdog timer — truly terminates hung Worker on catastrophic backtracking!
      this.activeTimer = setTimeout(() => {
        if (currentSeq !== this.seq) {
          return;
        }
        cleanupHandles(true);
        resolve({
          kind: "timeout",
          timeoutMs: this.timeoutMs,
        });
      }, this.timeoutMs);

      worker.onmessage = (ev: MessageEvent<RegexWorkerMessageOut>) => {
        if (currentSeq !== this.seq || ev.data.seq !== currentSeq) {
          return;
        }
        cleanupHandles(true);
        resolve({
          kind: "completed",
          result: ev.data.result,
        });
      };

      worker.onerror = (ev: ErrorEvent) => {
        if (currentSeq !== this.seq) {
          return;
        }
        cleanupHandles(true);
        resolve({
          kind: "worker_error",
          message: ev.message || "RegExp Worker failed to load or execute.",
        });
      };

      worker.postMessage({
        seq: currentSeq,
        request,
      });
    });
  }
}
