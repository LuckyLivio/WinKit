import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import type { Messages } from "../i18n/messages";

export interface AppRuntimeInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

export interface StructuredBackendError {
  code: string;
  message: string;
}

export interface TextFilePayload {
  path: string;
  fileName: string;
  byteLength: number;
  content: string;
}

export interface SavedFileInfo {
  path: string;
  byteLength: number;
}

export interface TaskProgressPayload {
  taskId: string;
  toolId: string;
  state: "running" | "completed" | "cancelled" | "error";
  processedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function parseBackendError(err: unknown): StructuredBackendError {
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.code === "string" && typeof obj.message === "string") {
      return { code: obj.code, message: obj.message };
    }
  }
  if (typeof err === "string") {
    try {
      const parsed: unknown = JSON.parse(err);
      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        if (typeof obj.code === "string" && typeof obj.message === "string") {
          return { code: obj.code, message: obj.message };
        }
      }
    } catch {
      return { code: "FALLBACK", message: err };
    }
  }
  if (err instanceof Error) {
    return { code: "FALLBACK", message: err.message };
  }
  return { code: "FALLBACK", message: "Unknown error" };
}

export function formatLocalizedError(err: unknown, messages: Messages): string {
  const parsed = parseBackendError(err);
  const key = parsed.code as keyof Messages["errors"];
  if (key in messages.errors && key !== "FALLBACK") {
    const base = messages.errors[key];
    if (key === "SIZE_LIMIT_EXCEEDED" && parsed.message) {
      return `${base} (${parsed.message})`;
    }
    return base;
  }
  return parsed.message || messages.errors.FALLBACK;
}

export async function fetchRuntimeInfo(): Promise<AppRuntimeInfo> {
  if (!isTauriDesktop()) {
    return {
      name: "WinKit",
      version: "0.1.0",
      platform: "web-test",
      arch: "x86_64",
    };
  }
  return invoke<AppRuntimeInfo>("get_runtime_info");
}

export async function pickSingleFile(options: {
  title?: string;
  filters?: DialogFilter[];
}): Promise<string | null> {
  if (!isTauriDesktop()) {
    return null;
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: options.title,
    filters: options.filters,
  });
  if (typeof selected === "string") {
    return selected;
  }
  return null;
}

export async function pickSaveFilePath(options: {
  title?: string;
  defaultPath?: string;
  filters?: DialogFilter[];
}): Promise<string | null> {
  if (!isTauriDesktop()) {
    return null;
  }
  const target = await save({
    title: options.title,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return typeof target === "string" ? target : null;
}

export async function readLocalTextFile(path: string): Promise<TextFilePayload> {
  return invoke<TextFilePayload>("read_text_file", { path });
}

export async function saveLocalTextFile(params: {
  outputPath: string;
  sourcePath: string | null;
  content: string;
  overwrite: boolean;
}): Promise<SavedFileInfo> {
  return invoke<SavedFileInfo>("save_text_file", params);
}

export async function suggestSafeSiblingPath(
  inputPath: string,
  suffix: string,
  extension: string,
): Promise<string | null> {
  if (!isTauriDesktop()) {
    return null;
  }
  try {
    return await invoke<string>("suggest_output_path", {
      inputPath,
      suffix,
      extension,
    });
  } catch {
    return null;
  }
}

export async function cancelBackendTask(taskId: string): Promise<boolean> {
  if (!isTauriDesktop()) {
    return false;
  }
  return invoke<boolean>("cancel_task", { taskId });
}

export async function subscribeTaskProgress(
  handler: (payload: TaskProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<TaskProgressPayload>("winkit://task-progress", (event) => {
    handler(event.payload);
  });
}

export async function subscribeFileDrop(handlers: {
  onHover?: (hovering: boolean) => void;
  onDropPaths: (paths: string[]) => void;
}): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  const win = getCurrentWindow();
  return win.onDragDropEvent((event) => {
    if (event.payload.type === "enter" || event.payload.type === "over") {
      handlers.onHover?.(true);
    } else if (event.payload.type === "leave") {
      handlers.onHover?.(false);
    } else if (event.payload.type === "drop") {
      handlers.onHover?.(false);
      if (event.payload.paths.length > 0) {
        handlers.onDropPaths(event.payload.paths);
      }
    }
  });
}

export async function subscribeWindowCloseGuard(
  getActiveCount: () => number,
  onBlockedClose: (count: number) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  const win = getCurrentWindow();
  return win.onCloseRequested(async (event) => {
    const localCount = getActiveCount();
    let backendCount: number;
    try {
      backendCount = await invoke<number>("get_running_task_count");
    } catch {
      backendCount = 0;
    }
    const active = Math.max(localCount, backendCount);
    if (active > 0) {
      event.preventDefault();
      onBlockedClose(active);
    }
  });
}

export async function forceDestroyWindow(): Promise<void> {
  if (!isTauriDesktop()) {
    return;
  }
  await getCurrentWindow().destroy();
}
