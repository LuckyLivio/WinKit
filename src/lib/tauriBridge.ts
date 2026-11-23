import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save, type DialogFilter } from "@tauri-apps/plugin-dialog";
import type { Messages } from "../i18n/messages";
import { assertFrontendNotShuttingDown } from "./shutdownGate";
import {
  decodeStringClient,
  encodeBytesClient,
  transformTextClientFallback,
  type CodecOptions,
  type CodecTransformResponse,
} from "../tools/codec/codecEngine";
import {
  ALGORITHM_HEX_LENGTHS,
  ALL_HASH_ALGORITHMS,
  computeMd5HexFallback,
  type AlgorithmDigestEntry,
  type HashAlgorithm,
} from "../tools/hash-generator/hashUtils";
import {
  generateUuidBatchClientFallback,
  inspectUuidClientFallback,
  type UuidGenVersion,
  type UuidInspectResult,
} from "../tools/uuid-generator/uuidEngine";
import {
  verifyJwtHmacClientFallback,
  type JwtHmacVerifyRequest,
  type JwtHmacVerifyResponse,
} from "../tools/jwt-decoder/jwtEngine";
import {
  inspectUnicodeClientFallback,
  type UnicodeInspectionResponse,
  type UnicodeSanitizeOptions,
} from "../tools/unicode-inspector/unicodeEngine";
import {
  generateSecretsClientFallback,
  type SecretGenRequest,
  type SecretGenResponse,
} from "../tools/password-generator/passwordEngine";
import type { BatchRenameSourceEntry } from "../tools/batch-rename/batchRenameEngine";
import type {
  DuplicateRecycleResponse,
  DuplicateScanOptions,
  DuplicateScanProgressPayload,
  DuplicateScanResult,
  RecycleGroupPlan,
} from "../tools/find-duplicates/findDuplicatesEngine";
import type {
  ArchivePreviewResponse,
  ArchiveProgressPayload,
  CreateArchiveRequest,
  CreateArchiveResponse,
  ExtractArchivesBatchResponse,
  ExtractArchivesRequest,
} from "../tools/archive/archiveModel";
import type {
  OrganizeExecuteRequest,
  OrganizeExecuteResponse,
  OrganizePreviewRequest,
  OrganizePreviewResponse,
} from "../tools/organize-downloads/organizeEngine";
import type {
  BatchImageJobResponse,
  CompressImagesBatchRequest,
  ConvertImagesBatchRequest,
  HeicCapabilities,
  ImageBatchProgressPayload,
  InspectBatchImagesResponse,
  PreviewCompressImageRequest,
  PreviewCompressImageResponse,
  PreviewConvertImageRequest,
  PreviewConvertImageResponse,
  PreviewRotateImageRequest,
  PreviewRotateImageResponse,
  ResizeImagesBatchRequest,
  RotateImagesBatchRequest,
  StripMetadataBatchRequest,
} from "../tools/image-batch/imageBatchModel";

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

export interface DiffTextFilePayload {
  path: string;
  fileName: string;
  byteLength: number;
  hasUtf8Bom: boolean;
  content: string;
}

export interface SavedFileInfo {
  path: string;
  byteLength: number;
}

export interface MultiTextHashResult {
  byteLength: number;
  digests: AlgorithmDigestEntry[];
}

export interface MultiFileHashResult {
  taskId: string;
  path: string;
  fileName: string;
  byteLength: number;
  digests: AlgorithmDigestEntry[];
}

export interface BatchHashInputItem {
  itemId: string;
  path: string;
}

export type BatchItemLifecycleState = "running" | "completed" | "cancelled" | "error";

export interface HashBatchItemProgressPayload {
  batchId: string;
  itemId: string;
  index: number;
  totalItems: number;
  state: BatchItemLifecycleState;
  processedBytes: number;
  totalBytes: number | null;
  percent: number | null;
  byteLength: number | null;
  digests: AlgorithmDigestEntry[] | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface BatchFileItemResult {
  itemId: string;
  path: string;
  fileName: string;
  status: BatchItemLifecycleState;
  byteLength: number | null;
  digests: AlgorithmDigestEntry[] | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface MultiFileBatchHashResult {
  batchId: string;
  cancelled: boolean;
  items: BatchFileItemResult[];
}

export interface SourceImageInspection {
  path: string;
  fileName: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  previewDataUrl: string;
}

export interface BeautifyExportParams {
  inputPath: string;
  outputPath: string;
  backgroundHex: string;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: "original" | "1:1" | "16:9";
  overwrite: boolean;
}

export interface BeautifyExportResult {
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
  byteLength: number;
}

export interface BatchRenameSkippedItem {
  path: string;
  reason: string;
}

export interface BatchRenameInspectResponse {
  entries: BatchRenameSourceEntry[];
  existingDirSiblings: Record<string, string[]>;
  skipped: BatchRenameSkippedItem[];
}

export interface RenamePairInput {
  sourcePath: string;
  newName: string;
}

export interface RenamedItemReport {
  oldPath: string;
  newPath: string;
  oldName: string;
  newName: string;
}

export interface BatchRenameUndoStatus {
  available: boolean;
  itemCount: number;
  completedAtMs: number | null;
}

export interface BatchRenameExecuteResponse {
  renamedCount: number;
  items: RenamedItemReport[];
  updatedInspection: BatchRenameInspectResponse;
  undoStatus: BatchRenameUndoStatus;
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

export interface ActiveTaskSummary {
  taskId: string;
  toolId: string;
  interruptible: boolean;
}

export interface TaskRegistrySnapshot {
  shuttingDown: boolean;
  activeCount: number;
  interruptibleCount: number;
  writeFinishingCount: number;
  tasks: ActiveTaskSummary[];
}

export interface CloseRequestDecision {
  immediateCloseAllowed: boolean;
  snapshot: TaskRegistrySnapshot;
}

export interface ShutdownDrainResult {
  readyToClose: boolean;
  remainingTasks: ActiveTaskSummary[];
}

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Safely binds an async Tauri event listener inside a React effect so that if the effect
 * unmounts BEFORE the registration Promise resolves (e.g. React StrictMode double-mount or
 * rapid workspace navigation), the returned `UnlistenFn` is called immediately on resolution
 * rather than leaking a duplicate listener.
 */
export function bindDisposableListener(
  subscribe: () => Promise<UnlistenFn>,
  label: string,
): () => void {
  let disposed = false;
  let unlisten: UnlistenFn | null = null;

  subscribe()
    .then((fn) => {
      if (disposed) {
        fn();
      } else {
        unlisten = fn;
      }
    })
    .catch((err) => {
      if (!disposed) {
        console.error(`[WinKit] Failed to register listener (${label}):`, err);
      }
    });

  return () => {
    disposed = true;
    if (unlisten) {
      const fn = unlisten;
      unlisten = null;
      fn();
    }
  };
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
    if ((key === "SIZE_LIMIT_EXCEEDED" || key === "DECODE_FAILED") && parsed.message) {
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
      version: "0.10.0",
      platform: "web-test",
      arch: "x86_64",
    };
  }
  return invoke<AppRuntimeInfo>("get_runtime_info");
}

export async function readSystemClipboardText(): Promise<string> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
      return navigator.clipboard.readText();
    }
    return "";
  }
  return invoke<string>("read_clipboard_text");
}

export async function writeSystemClipboardText(text: string): Promise<void> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    }
    return;
  }
  await invoke<void>("write_clipboard_text", { text });
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

export async function pickMultipleFiles(options: {
  title?: string;
  filters?: DialogFilter[];
}): Promise<string[]> {
  if (!isTauriDesktop()) {
    return [];
  }
  const selected = await open({
    multiple: true,
    directory: false,
    title: options.title,
    filters: options.filters,
  });
  if (Array.isArray(selected)) {
    return selected.filter((item): item is string => typeof item === "string");
  }
  if (typeof selected === "string") {
    return [selected];
  }
  return [];
}

export async function pickSingleDirectory(options: { title?: string }): Promise<string | null> {
  if (!isTauriDesktop()) {
    return null;
  }
  const selected = await open({
    multiple: false,
    directory: true,
    title: options.title,
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickMultipleDirectories(options: { title?: string }): Promise<string[]> {
  if (!isTauriDesktop()) {
    return [];
  }
  const selected = await open({
    multiple: true,
    directory: true,
    title: options.title,
  });
  if (Array.isArray(selected)) {
    return selected.filter((item): item is string => typeof item === "string");
  }
  if (typeof selected === "string") {
    return [selected];
  }
  return [];
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
  assertFrontendNotShuttingDown();
  return invoke<TextFilePayload>("read_text_file", { path });
}

export async function readDiffTextFile(path: string, toolId = "D07"): Promise<DiffTextFilePayload> {
  assertFrontendNotShuttingDown();
  return invoke<DiffTextFilePayload>("read_diff_text_file", { path, toolId });
}

export async function readTabularTextFile(path: string): Promise<DiffTextFilePayload> {
  assertFrontendNotShuttingDown();
  return invoke<DiffTextFilePayload>("read_tabular_text_file", { path });
}

export async function readCoordBatchTextFile(path: string): Promise<DiffTextFilePayload> {
  assertFrontendNotShuttingDown();
  return invoke<DiffTextFilePayload>("read_coord_batch_text_file", { path });
}

export async function saveLocalTextFile(params: {
  outputPath: string;
  sourcePath: string | null;
  secondarySourcePath?: string | null;
  forbiddenSourcePaths?: string[];
  content: string;
  overwrite: boolean;
  toolId?: string;
}): Promise<SavedFileInfo> {
  assertFrontendNotShuttingDown();
  return invoke<SavedFileInfo>("save_text_file", {
    params: {
      outputPath: params.outputPath,
      sourcePath: params.sourcePath,
      secondarySourcePath: params.secondarySourcePath ?? null,
      forbiddenSourcePaths: params.forbiddenSourcePaths ?? [],
      content: params.content,
      overwrite: params.overwrite,
      toolId: params.toolId ?? "D01",
    },
  });
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

export async function fetchTaskSnapshot(): Promise<TaskRegistrySnapshot> {
  if (!isTauriDesktop()) {
    return {
      shuttingDown: false,
      activeCount: 0,
      interruptibleCount: 0,
      writeFinishingCount: 0,
      tasks: [],
    };
  }
  return invoke<TaskRegistrySnapshot>("get_task_snapshot");
}

export async function requestWindowClose(): Promise<CloseRequestDecision> {
  if (!isTauriDesktop()) {
    return {
      immediateCloseAllowed: true,
      snapshot: {
        shuttingDown: true,
        activeCount: 0,
        interruptibleCount: 0,
        writeFinishingCount: 0,
        tasks: [],
      },
    };
  }
  return invoke<CloseRequestDecision>("request_window_close");
}

export async function beginGracefulShutdown(timeoutMs = 8000): Promise<ShutdownDrainResult> {
  if (!isTauriDesktop()) {
    return { readyToClose: true, remainingTasks: [] };
  }
  return invoke<ShutdownDrainResult>("begin_graceful_shutdown", { timeoutMs });
}

export async function abortGracefulShutdown(): Promise<void> {
  if (!isTauriDesktop()) {
    return;
  }
  await invoke<void>("abort_graceful_shutdown");
}

export async function computeTextHashes(
  text: string,
  algorithms: readonly HashAlgorithm[],
): Promise<MultiTextHashResult> {
  if (algorithms.length === 0) {
    throw JSON.stringify({
      code: "INVALID_PARAMETER",
      message: "At least one hash algorithm must be selected.",
    });
  }
  if (!isTauriDesktop()) {
    const bytes = new TextEncoder().encode(text);
    const ordered = ALL_HASH_ALGORITHMS.filter((alg) => algorithms.includes(alg));
    const digests: AlgorithmDigestEntry[] = [];
    for (const alg of ordered) {
      if (alg === "MD5") {
        digests.push({
          algorithm: "MD5",
          hexLength: ALGORITHM_HEX_LENGTHS.MD5,
          digestHex: computeMd5HexFallback(bytes),
        });
      } else {
        const buf = await globalThis.crypto.subtle.digest(alg, bytes);
        const digestHex = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
        digests.push({
          algorithm: alg,
          hexLength: ALGORITHM_HEX_LENGTHS[alg],
          digestHex,
        });
      }
    }
    return {
      byteLength: bytes.byteLength,
      digests,
    };
  }
  return invoke<MultiTextHashResult>("hash_text_multi", { text, algorithms });
}

export async function computeFileHashes(
  taskId: string,
  path: string,
  algorithms: readonly HashAlgorithm[],
): Promise<MultiFileHashResult> {
  assertFrontendNotShuttingDown();
  return invoke<MultiFileHashResult>("hash_file_multi", { taskId, path, algorithms });
}

export async function computeBatchFileHashes(
  batchId: string,
  items: readonly BatchHashInputItem[],
  algorithms: readonly HashAlgorithm[],
): Promise<MultiFileBatchHashResult> {
  assertFrontendNotShuttingDown();
  return invoke<MultiFileBatchHashResult>("hash_files_batch", {
    batchId,
    items,
    algorithms,
  });
}

export async function subscribeHashBatchItemProgress(
  handler: (payload: HashBatchItemProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<HashBatchItemProgressPayload>("winkit://hash-batch-item", (event) => {
    handler(event.payload);
  });
}

export async function codecTransformText(
  text: string,
  options: CodecOptions,
): Promise<CodecTransformResponse> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    return transformTextClientFallback(text, options);
  }
  return invoke<CodecTransformResponse>("codec_transform_text", { text, options });
}

export async function codecTransformFile(
  path: string,
  options: CodecOptions,
): Promise<CodecTransformResponse> {
  assertFrontendNotShuttingDown();
  return invoke<CodecTransformResponse>("codec_transform_file", { path, options });
}

export async function codecGetFullText(params: {
  textInput: string | null;
  filePath: string | null;
  options: CodecOptions;
}): Promise<string> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    const text = params.textInput ?? "";
    if (params.options.operation === "encode") {
      return encodeBytesClient(new TextEncoder().encode(text), params.options);
    }
    const decoded = decodeStringClient(text, params.options);
    return new TextDecoder("utf-8", { fatal: true }).decode(decoded);
  }
  return invoke<string>("codec_get_full_text", params);
}

export async function codecSaveOutput(params: {
  textInput: string | null;
  sourceFilePath: string | null;
  outputPath: string;
  overwrite: boolean;
  options: CodecOptions;
}): Promise<SavedFileInfo> {
  assertFrontendNotShuttingDown();
  return invoke<SavedFileInfo>("codec_save_output", params);
}

export async function generateUuidBatch(version: UuidGenVersion, count: number): Promise<string[]> {
  if (!isTauriDesktop()) {
    return generateUuidBatchClientFallback(version, count);
  }
  return invoke<string[]>("generate_uuids", { version, count });
}

export async function inspectUuidString(input: string): Promise<UuidInspectResult> {
  if (!isTauriDesktop()) {
    return inspectUuidClientFallback(input);
  }
  return invoke<UuidInspectResult>("inspect_uuid", { input });
}

export async function generateSecretsBatch(req: SecretGenRequest): Promise<SecretGenResponse> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    return generateSecretsClientFallback(req);
  }
  return invoke<SecretGenResponse>("generate_secrets", { req });
}

export async function verifyJwtHmac(req: JwtHmacVerifyRequest): Promise<JwtHmacVerifyResponse> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    return verifyJwtHmacClientFallback(req);
  }
  return invoke<JwtHmacVerifyResponse>("verify_jwt_hmac", { req });
}

export async function inspectUnicodeText(
  text: string,
  options: UnicodeSanitizeOptions,
): Promise<UnicodeInspectionResponse> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    return inspectUnicodeClientFallback(text, options);
  }
  return invoke<UnicodeInspectionResponse>("inspect_unicode_text", { text, options });
}

export async function inspectBeautifierSourceImage(path: string): Promise<SourceImageInspection> {
  assertFrontendNotShuttingDown();
  return invoke<SourceImageInspection>("inspect_beautifier_image", { path });
}

export async function exportBeautifiedImage(
  params: BeautifyExportParams,
): Promise<BeautifyExportResult> {
  assertFrontendNotShuttingDown();
  return invoke<BeautifyExportResult>("export_beautified_png", { params });
}

export async function inspectBatchRenameSources(
  paths: string[],
): Promise<BatchRenameInspectResponse> {
  assertFrontendNotShuttingDown();
  if (!isTauriDesktop()) {
    return { entries: [], existingDirSiblings: {}, skipped: [] };
  }
  return invoke<BatchRenameInspectResponse>("inspect_batch_rename_sources", { paths });
}

export async function executeBatchRename(
  operations: RenamePairInput[],
  currentPaths: string[],
): Promise<BatchRenameExecuteResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchRenameExecuteResponse>("execute_batch_rename", {
    operations,
    currentPaths,
  });
}

export async function undoLastBatchRename(
  currentPaths: string[],
): Promise<BatchRenameExecuteResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchRenameExecuteResponse>("undo_last_batch_rename", {
    currentPaths,
  });
}

export async function getBatchRenameUndoStatus(): Promise<BatchRenameUndoStatus> {
  if (!isTauriDesktop()) {
    return { available: false, itemCount: 0, completedAtMs: null };
  }
  return invoke<BatchRenameUndoStatus>("get_batch_rename_undo_status");
}

export async function scanDuplicateFolders(
  taskId: string,
  options: DuplicateScanOptions,
): Promise<DuplicateScanResult> {
  assertFrontendNotShuttingDown();
  return invoke<DuplicateScanResult>("scan_duplicate_folders", {
    taskId,
    options,
  });
}

export async function recycleDuplicateGroups(
  plans: RecycleGroupPlan[],
): Promise<DuplicateRecycleResponse> {
  assertFrontendNotShuttingDown();
  return invoke<DuplicateRecycleResponse>("recycle_duplicate_groups", { plans });
}

export async function subscribeDuplicateScanProgress(
  handler: (payload: DuplicateScanProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<DuplicateScanProgressPayload>("winkit://duplicates-scan-progress", (event) => {
    handler(event.payload);
  });
}

export async function inspectArchive(
  path: string,
  password?: string | null,
): Promise<ArchivePreviewResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ArchivePreviewResponse>("inspect_archive", {
    path,
    password: password ?? null,
  });
}

export async function extractArchivesBatch(
  taskId: string,
  request: ExtractArchivesRequest,
): Promise<ExtractArchivesBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ExtractArchivesBatchResponse>("extract_archives_batch", {
    taskId,
    req: request,
  });
}

export async function createArchive(
  taskId: string,
  request: CreateArchiveRequest,
): Promise<CreateArchiveResponse> {
  assertFrontendNotShuttingDown();
  return invoke<CreateArchiveResponse>("create_archive", {
    taskId,
    req: request,
  });
}

export async function openLocalDirectory(path: string): Promise<void> {
  if (!isTauriDesktop()) {
    return;
  }
  await invoke<void>("open_local_directory", { path });
}

export async function previewOrganizeDownloads(
  req: OrganizePreviewRequest,
): Promise<OrganizePreviewResponse> {
  assertFrontendNotShuttingDown();
  return invoke<OrganizePreviewResponse>("preview_organize_downloads", { req });
}

export async function executeOrganizeDownloads(
  req: OrganizeExecuteRequest,
): Promise<OrganizeExecuteResponse> {
  assertFrontendNotShuttingDown();
  return invoke<OrganizeExecuteResponse>("execute_organize_downloads", { req });
}

export async function getImageHeicCapabilities(): Promise<HeicCapabilities> {
  if (!isTauriDesktop()) {
    return {
      decodeAvailable: false,
      encodeAvailable: false,
      decodeNote: "Browser test mode",
      encodeNote: "Browser test mode",
    };
  }
  return invoke<HeicCapabilities>("get_image_heic_capabilities");
}

export async function inspectBatchImages(paths: string[]): Promise<InspectBatchImagesResponse> {
  assertFrontendNotShuttingDown();
  return invoke<InspectBatchImagesResponse>("inspect_batch_images", { paths });
}

export async function previewConvertImage(
  req: PreviewConvertImageRequest,
): Promise<PreviewConvertImageResponse> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewConvertImageResponse>("preview_convert_image", { req });
}

export async function convertImagesBatch(
  taskId: string,
  req: ConvertImagesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("convert_images_batch", { taskId, req });
}

export async function previewCompressImage(
  req: PreviewCompressImageRequest,
): Promise<PreviewCompressImageResponse> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewCompressImageResponse>("preview_compress_image", { req });
}

export async function compressImagesBatch(
  taskId: string,
  req: CompressImagesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("compress_images_batch", { taskId, req });
}

export async function resizeImagesBatch(
  taskId: string,
  req: ResizeImagesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("resize_images_batch", { taskId, req });
}

export async function previewRotateImage(
  req: PreviewRotateImageRequest,
): Promise<PreviewRotateImageResponse> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewRotateImageResponse>("preview_rotate_image", { req });
}

export async function rotateImagesBatch(
  taskId: string,
  req: RotateImagesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("rotate_images_batch", { taskId, req });
}

export async function stripImagesMetadataBatch(
  taskId: string,
  req: StripMetadataBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("strip_images_metadata_batch", { taskId, req });
}

export async function subscribeImageBatchProgress(
  handler: (payload: ImageBatchProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<ImageBatchProgressPayload>("winkit://image-batch-progress", (event) => {
    handler(event.payload);
  });
}

export async function subscribeArchiveProgress(
  handler: (payload: ArchiveProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<ArchiveProgressPayload>("winkit://archive-progress", (event) => {
    handler(event.payload);
  });
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

/**
 * Registers the native window close request listener.
 * Always calls `event.preventDefault()` synchronously before delegating to `onCloseRequest`
 * so the caller controls idle vs. guarded `destroyCurrentWindow()` inside explicit error handling.
 */
export async function subscribeNativeCloseRequest(
  onCloseRequest: () => Promise<void> | void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  const win = getCurrentWindow();
  return win.onCloseRequested(async (event) => {
    event.preventDefault();
    await onCloseRequest();
  });
}

export async function destroyCurrentWindow(): Promise<void> {
  if (!isTauriDesktop()) {
    return;
  }
  await getCurrentWindow().destroy();
}
