/**
 * Synchronizes frontend task/Worker initiation with the application window shutdown flow.
 * File side effects remain authoritatively guarded by the Rust `TaskRegistry` mutex; this gate
 * prevents starting new IPC calls or Web Workers after shutdown begins and ensures pure-memory
 * Workers are terminated cleanly when closing.
 */

let shuttingDown = false;
const activeWorkerDisposers = new Set<() => void>();

export function isFrontendShuttingDown(): boolean {
  return shuttingDown;
}

export function assertFrontendNotShuttingDown(): void {
  if (shuttingDown) {
    throw JSON.stringify({
      code: "APP_SHUTTING_DOWN",
      message: "Application is shutting down; new tasks cannot be started.",
    });
  }
}

export function enterFrontendShutdownGate(): void {
  shuttingDown = true;
}

export function resetFrontendShutdownGate(): void {
  shuttingDown = false;
}

export function registerCancelableFrontendWorker(dispose: () => void): () => void {
  activeWorkerDisposers.add(dispose);
  return () => {
    activeWorkerDisposers.delete(dispose);
  };
}

export function terminateAllFrontendWorkers(): void {
  const callbacks = Array.from(activeWorkerDisposers);
  activeWorkerDisposers.clear();
  for (const dispose of callbacks) {
    try {
      dispose();
    } catch {
      // Ignore worker disposal errors during shutdown cleanup
    }
  }
}
