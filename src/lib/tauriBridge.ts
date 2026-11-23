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

export type BeautifyBackgroundKind = "solid" | "gradient" | "image";
export type BeautifyAspectPreset = "original" | "1:1" | "16:9" | "4:5" | "9:16";

export interface BeautifyStyleConfig {
  backgroundKind: BeautifyBackgroundKind;
  backgroundHex: string;
  gradientStartHex?: string | null;
  gradientEndHex?: string | null;
  gradientAngleDeg?: number | null;
  backgroundImagePath?: string | null;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: BeautifyAspectPreset;
}

export interface BeautifyExportParams {
  inputPath?: string | null;
  assetId?: string | null;
  outputPath: string;
  backgroundKind?: BeautifyBackgroundKind;
  backgroundHex: string;
  gradientStartHex?: string | null;
  gradientEndHex?: string | null;
  gradientAngleDeg?: number | null;
  backgroundImagePath?: string | null;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: BeautifyAspectPreset;
  overwrite: boolean;
}

export interface BeautifyRenderAssetRequest {
  inputPath?: string | null;
  assetId?: string | null;
  label?: string | null;
  style: BeautifyStyleConfig;
}

export interface BeautifyBatchRequest {
  sourcePaths: string[];
  outputDir: string;
  style: BeautifyStyleConfig;
}

export interface BeautifyExportResult {
  outputPath: string;
  outputWidth: number;
  outputHeight: number;
  byteLength: number;
}

export interface ImageAssetPayload {
  assetId: string;
  label: string;
  width: number;
  height: number;
  hasAlpha: boolean;
  byteLength: number;
  dataUrl: string;
}

export type SaveAssetFormat = "png" | "jpeg";

export interface SavedImageAssetResult {
  outputPath: string;
  width: number;
  height: number;
  byteLength: number;
}

export type RedactionKind = "blur" | "pixelate" | "solid";

export interface RedactionRegionPayload {
  kind: RedactionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  strength: number;
  colorHex?: string | null;
}

export interface ApplyRedactionsAssetRequest {
  assetId: string;
  regions: RedactionRegionPayload[];
  label?: string | null;
}

export interface ExportRedactedImageRequest {
  assetId: string;
  sourcePath?: string | null;
  regions: RedactionRegionPayload[];
  outputPath: string;
  format: SaveAssetFormat;
  jpegQuality?: number | null;
  stripMetadata: boolean;
  overwrite: boolean;
}

export interface ExportRedactedImageResult {
  outputPath: string;
  width: number;
  height: number;
  byteLength: number;
  metadataStripped: boolean;
}

export type WatermarkPlacement =
  | "top_left"
  | "top_center"
  | "top_right"
  | "middle_left"
  | "center"
  | "middle_right"
  | "bottom_left"
  | "bottom_center"
  | "bottom_right"
  | "diagonal_tile";

export interface WatermarkStyleConfig {
  stampPngDataUrl?: string | null;
  logoPath?: string | null;
  placement: WatermarkPlacement;
  scalePercent: number;
  marginPercent: number;
  opacityPercent: number;
  tileAngleDeg?: number | null;
  tileSpacingPercent?: number | null;
}

export interface RenderWatermarkedAssetRequest {
  assetId?: string | null;
  inputPath?: string | null;
  label?: string | null;
  style: WatermarkStyleConfig;
}

export interface WatermarkImagesBatchRequest {
  sourcePaths: string[];
  outputDir: string;
  style: WatermarkStyleConfig;
}

export type FaceDetectionStatus = "detected" | "no_faces";

export interface DetectedFaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface FaceDetectionResult {
  status: FaceDetectionStatus;
  faces: DetectedFaceBox[];
  imageWidth: number;
  imageHeight: number;
  elapsedMs: number;
  modelName: string;
}

export interface DetectFacesAssetRequest {
  assetId: string;
  scoreThreshold?: number | null;
}

export interface DetectFacesFileRequest {
  path: string;
  scoreThreshold?: number | null;
}

export interface BlurFacesBatchItemInput {
  sourcePath: string;
  overrideRegions?: RedactionRegionPayload[] | null;
}

export interface BlurFacesBatchRequest {
  items: BlurFacesBatchItemInput[];
  outputDir: string;
  defaultKind: RedactionKind;
  defaultStrength: number;
  defaultColorHex?: string | null;
  scoreThreshold?: number | null;
  format: SaveAssetFormat;
  jpegQuality?: number | null;
  stripMetadata: boolean;
  exportUntouchedCopies: boolean;
}

export interface PickScreenColorRequest {
  hideMainWindow?: boolean | null;
}

export interface SampleScreenPixelRequest {
  physicalX: number;
  physicalY: number;
  hideMainWindow?: boolean | null;
}

export interface ScreenColorSample {
  r: number;
  g: number;
  b: number;
  hex: string;
  physicalX: number;
  physicalY: number;
  monitorId: string | null;
  scalePercent: number;
  compositedRgbOnly: boolean;
}

export interface ExtractImagePaletteRequest {
  assetId?: string | null;
  path?: string | null;
  maxColors?: number | null;
}

export interface PaletteSwatch {
  r: number;
  g: number;
  b: number;
  hex: string;
  sharePercent: number;
}

export interface ImagePaletteResult {
  swatches: PaletteSwatch[];
  totalPixels: number;
  opaquePixels: number;
  excludedTransparentPixels: number;
  distinctColorCount: number;
  width: number;
  height: number;
}

export interface CaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureMonitorInfo {
  id: string;
  deviceName: string;
  isPrimary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  scalePercent: number;
}

export interface CaptureWindowInfo {
  hwnd: number;
  title: string;
  processName: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isProtected: boolean;
}

export type ScrollStopReason =
  | "reached_bottom"
  | "user_stopped"
  | "alignment_failed"
  | "size_limit_reached"
  | "max_frames_reached"
  | "single_frame_only";

export interface CaptureProgressPayload {
  taskId: string;
  phase: string;
  countdownRemaining: number | null;
  frameCount: number;
  stitchedHeight: number;
}

export interface CaptureResultPayload {
  asset: ImageAssetPayload;
  mode: string;
  rect: CaptureRect;
  frameCount: number;
  stopReason: ScrollStopReason | null;
  isPartial: boolean;
  note: string | null;
}

export interface CaptureRegionRequest {
  countdownSeconds: number;
  includeCursor: boolean;
  explicitRect?: CaptureRect | null;
  hideMainWindow?: boolean | null;
}

export interface CaptureMonitorRequest {
  monitorId: string;
  countdownSeconds: number;
  includeCursor: boolean;
  hideMainWindow?: boolean | null;
}

export interface CaptureWindowRequest {
  hwnd: number;
  countdownSeconds: number;
  includeCursor: boolean;
  hideMainWindow?: boolean | null;
}

export interface CaptureScrollRequest {
  countdownSeconds: number;
  maxFrames?: number | null;
  maxHeight?: number | null;
  wheelNotches?: number | null;
  stepDelayMs?: number | null;
  explicitRect?: CaptureRect | null;
  hideMainWindow?: boolean | null;
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
      version: "0.13.0",
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

export async function renderBeautifiedAsset(
  req: BeautifyRenderAssetRequest,
): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("render_beautified_asset", { req });
}

export async function beautifyImagesBatch(
  taskId: string,
  req: BeautifyBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("beautify_images_batch", { taskId, req });
}

export async function listCaptureMonitors(): Promise<CaptureMonitorInfo[]> {
  if (!isTauriDesktop()) return [];
  return invoke<CaptureMonitorInfo[]>("list_capture_monitors");
}

export async function listCaptureWindows(): Promise<CaptureWindowInfo[]> {
  if (!isTauriDesktop()) return [];
  return invoke<CaptureWindowInfo[]>("list_capture_windows");
}

export async function captureScreenRegion(
  taskId: string,
  req: CaptureRegionRequest,
): Promise<CaptureResultPayload> {
  assertFrontendNotShuttingDown();
  return invoke<CaptureResultPayload>("capture_screen_region", { taskId, req });
}

export async function captureScreenMonitor(
  taskId: string,
  req: CaptureMonitorRequest,
): Promise<CaptureResultPayload> {
  assertFrontendNotShuttingDown();
  return invoke<CaptureResultPayload>("capture_screen_monitor", { taskId, req });
}

export async function captureScreenWindow(
  taskId: string,
  req: CaptureWindowRequest,
): Promise<CaptureResultPayload> {
  assertFrontendNotShuttingDown();
  return invoke<CaptureResultPayload>("capture_screen_window", { taskId, req });
}

export async function captureScreenScroll(
  taskId: string,
  req: CaptureScrollRequest,
): Promise<CaptureResultPayload> {
  assertFrontendNotShuttingDown();
  return invoke<CaptureResultPayload>("capture_screen_scroll", { taskId, req });
}

export async function subscribeCaptureProgress(
  handler: (payload: CaptureProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<CaptureProgressPayload>("winkit://capture-progress", (event) => {
    handler(event.payload);
  });
}

export async function storePngAsset(dataUrl: string, label: string): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("store_png_asset", { dataUrl, label });
}

export async function loadFileAsImageAsset(path: string): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("load_file_as_image_asset", { path });
}

export async function getImageAsset(assetId: string): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("get_image_asset", { assetId });
}

export async function copyImageAssetToClipboard(params: {
  assetId?: string | null;
  dataUrl?: string | null;
}): Promise<void> {
  assertFrontendNotShuttingDown();
  return invoke<void>("copy_image_asset_to_clipboard", {
    assetId: params.assetId ?? null,
    dataUrl: params.dataUrl ?? null,
  });
}

export async function readClipboardImageAsAsset(): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("read_clipboard_image_as_asset");
}

export async function saveImageAssetFile(params: {
  assetId?: string | null;
  dataUrl?: string | null;
  outputPath: string;
  format: SaveAssetFormat;
  jpegQuality?: number;
  overwrite: boolean;
  toolId?: string;
}): Promise<SavedImageAssetResult> {
  assertFrontendNotShuttingDown();
  return invoke<SavedImageAssetResult>("save_image_asset_file", {
    assetId: params.assetId ?? null,
    dataUrl: params.dataUrl ?? null,
    outputPath: params.outputPath,
    format: params.format,
    jpegQuality: params.jpegQuality ?? 92,
    overwrite: params.overwrite,
    toolId: params.toolId ?? "I01",
  });
}

export async function applyImageRedactionsToAsset(
  req: ApplyRedactionsAssetRequest,
): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("apply_image_redactions_to_asset", { req });
}

export async function exportRedactedImageFile(
  req: ExportRedactedImageRequest,
): Promise<ExportRedactedImageResult> {
  assertFrontendNotShuttingDown();
  return invoke<ExportRedactedImageResult>("export_redacted_image_file", { req });
}

export async function renderWatermarkedAsset(
  req: RenderWatermarkedAssetRequest,
): Promise<ImageAssetPayload> {
  assertFrontendNotShuttingDown();
  return invoke<ImageAssetPayload>("render_watermarked_asset", { req });
}

export async function watermarkImagesBatch(
  taskId: string,
  req: WatermarkImagesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("watermark_images_batch", { taskId, req });
}

export async function detectFacesInAsset(
  req: DetectFacesAssetRequest,
): Promise<FaceDetectionResult> {
  assertFrontendNotShuttingDown();
  return invoke<FaceDetectionResult>("detect_faces_in_asset", { req });
}

export async function detectFacesInFile(req: DetectFacesFileRequest): Promise<FaceDetectionResult> {
  assertFrontendNotShuttingDown();
  return invoke<FaceDetectionResult>("detect_faces_in_file", { req });
}

export async function blurFacesBatch(
  taskId: string,
  req: BlurFacesBatchRequest,
): Promise<BatchImageJobResponse> {
  assertFrontendNotShuttingDown();
  return invoke<BatchImageJobResponse>("blur_faces_batch", { taskId, req });
}

export async function pickScreenColor(req?: PickScreenColorRequest): Promise<ScreenColorSample> {
  assertFrontendNotShuttingDown();
  return invoke<ScreenColorSample>("pick_screen_color", { req: req ?? null });
}

export async function sampleScreenPixelAt(
  req: SampleScreenPixelRequest,
): Promise<ScreenColorSample> {
  assertFrontendNotShuttingDown();
  return invoke<ScreenColorSample>("sample_screen_pixel_at", { req });
}

export async function extractImagePalette(
  req: ExtractImagePaletteRequest,
): Promise<ImagePaletteResult> {
  assertFrontendNotShuttingDown();
  return invoke<ImagePaletteResult>("extract_image_palette", { req });
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

// ---------- Phase 4A: Shared Local Media Runtime (FFmpeg / ffprobe), V10, V11 ----------

export interface ManagedFfmpegSpec {
  version: string;
  sourceName: string;
  releaseUrl: string;
  sourceCommitUrl: string;
  downloadUrl: string;
  downloadBytes: number;
  sha256: string;
  estimatedInstalledBytes: number;
  licenseName: string;
}

export type MediaToolsMode = "auto" | "custom";
export type MediaToolsSource = "managed" | "system_path" | "custom" | "missing";

export interface MediaToolsStatus {
  ready: boolean;
  source: MediaToolsSource;
  mode: MediaToolsMode;
  customDir: string | null;
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  ffprobeVersion: string | null;
  installDir: string;
  managedInstalledBytes: number | null;
  licensePath: string | null;
  error: string | null;
  spec: ManagedFfmpegSpec;
}

export interface MediaSetupProgressPayload {
  taskId: string;
  phase: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
  message: string;
}

export interface MediaTaskProgressPayload {
  taskId: string;
  toolId: string;
  phase: string;
  currentItem: number;
  totalItems: number;
  itemName: string | null;
  percent: number | null;
  outTimeSec: number | null;
  totalDurationSec: number | null;
}

export interface MediaPreviewRegistration {
  token: string;
  url: string;
  mimeType: string;
  fileName: string;
  byteLength: number;
}

export interface VideoStreamInfo {
  index: number;
  codecName: string | null;
  codecLongName: string | null;
  profile: string | null;
  pixelFormat: string | null;
  codedWidth: number | null;
  codedHeight: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  sampleAspectRatio: string | null;
  rotationDegrees: number | null;
  orientation: string | null;
  avgFrameRate: number | null;
  rFrameRate: number | null;
  avgFrameRateRaw: string | null;
  rFrameRateRaw: string | null;
  isVariableFrameRate: boolean | null;
  bitrateBps: number | null;
  colorSpace: string | null;
  colorTransfer: string | null;
  colorPrimaries: string | null;
  durationSec: number | null;
}

export interface AudioStreamInfo {
  index: number;
  audioTrackIndex: number;
  codecName: string | null;
  codecLongName: string | null;
  profile: string | null;
  language: string | null;
  title: string | null;
  channels: number | null;
  channelLayout: string | null;
  sampleRateHz: number | null;
  bitrateBps: number | null;
  durationSec: number | null;
  isDefault: boolean;
}

export interface SubtitleStreamInfo {
  index: number;
  codecName: string | null;
  language: string | null;
  title: string | null;
}

export interface MediaProbeReport {
  path: string;
  fileName: string;
  byteSize: number;
  containerFormat: string | null;
  containerLongName: string | null;
  durationSec: number | null;
  overallBitrateBps: number | null;
  streamCount: number;
  hasVideo: boolean;
  hasAudio: boolean;
  videoStreams: VideoStreamInfo[];
  audioStreams: AudioStreamInfo[];
  subtitleStreams: SubtitleStreamInfo[];
  formatTags: Record<string, string>;
  summaryText: string;
  rawJson: string;
}

export type VideoTrimMode = "stream_copy" | "accurate";

export interface TrimKeyframeAnalysis {
  requestedStartSec: number;
  requestedEndSec: number;
  actualStreamCopyStartSec: number;
  startDeltaSec: number;
  estimatedStreamCopyDurationSec: number;
  hasKeyframeShift: boolean;
  nearestNextKeyframeSec: number | null;
  keyframeCountSampled: number;
}

export interface TrimVideoRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  mode: VideoTrimMode;
  allowOverwrite?: boolean;
}

export interface TrimVideoResult {
  outputPath: string;
  byteSize: number;
  durationSec: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  rotationDegrees: number | null;
  mode: VideoTrimMode;
  requestedStartSec: number;
  requestedEndSec: number;
  elapsedMs: number;
}

export async function getMediaToolsStatus(): Promise<MediaToolsStatus> {
  return invoke<MediaToolsStatus>("get_media_tools_status");
}

export async function setMediaToolsCustomDir(dir: string | null): Promise<MediaToolsStatus> {
  assertFrontendNotShuttingDown();
  return invoke<MediaToolsStatus>("set_media_tools_custom_dir", { dir });
}

export async function installManagedMediaTools(taskId: string): Promise<MediaToolsStatus> {
  assertFrontendNotShuttingDown();
  return invoke<MediaToolsStatus>("install_managed_media_tools", { taskId });
}

export async function registerMediaPreviewPath(path: string): Promise<MediaPreviewRegistration> {
  return invoke<MediaPreviewRegistration>("register_media_preview_path", { path });
}

export async function extractMediaPosterDataUrl(path: string, timeSec?: number): Promise<string> {
  assertFrontendNotShuttingDown();
  return invoke<string>("extract_media_poster_data_url", { path, timeSec: timeSec ?? null });
}

export async function probeMediaInfo(path: string): Promise<MediaProbeReport> {
  assertFrontendNotShuttingDown();
  return invoke<MediaProbeReport>("probe_media_info", { path });
}

export async function analyzeTrimKeyframes(
  path: string,
  startSec: number,
  endSec: number,
): Promise<TrimKeyframeAnalysis> {
  assertFrontendNotShuttingDown();
  return invoke<TrimKeyframeAnalysis>("analyze_trim_keyframes", {
    req: { path, startSec, endSec },
  });
}

export async function trimVideoFile(req: TrimVideoRequest): Promise<TrimVideoResult> {
  assertFrontendNotShuttingDown();
  return invoke<TrimVideoResult>("trim_video_file", { req });
}

export async function subscribeMediaSetupProgress(
  handler: (payload: MediaSetupProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<MediaSetupProgressPayload>("winkit://media-setup-progress", (event) => {
    handler(event.payload);
  });
}

export async function subscribeMediaTaskProgress(
  handler: (payload: MediaTaskProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<MediaTaskProgressPayload>("winkit://media-progress", (event) => {
    handler(event.payload);
  });
}

// ---------- Phase 4A Batch 2: V13 Mute Video & A04 Extract Audio ----------

export interface MuteVideosBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
}

export type MuteItemStatus = "muted" | "already_muted" | "skipped" | "failed";

export interface MuteVideoItemResult {
  sourcePath: string;
  fileName: string;
  status: MuteItemStatus;
  outputPath: string | null;
  byteSize: number | null;
  removedAudioTracks: number;
  durationSec: number | null;
  displayWidth: number | null;
  displayHeight: number | null;
  rotationDegrees: number | null;
  message: string | null;
}

export interface MuteVideosBatchResponse {
  taskId: string;
  outputDir: string;
  cancelled: boolean;
  mutedCount: number;
  alreadyMutedCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: MuteVideoItemResult[];
}

export type AudioExtractFormat = "m4a" | "mp3" | "wav" | "flac";

export interface ExtractAudioItemInput {
  sourcePath: string;
  audioTrackIndex: number;
}

export interface ExtractAudioBatchRequest {
  taskId: string;
  items: ExtractAudioItemInput[];
  outputDir: string;
  format: AudioExtractFormat;
  preferStreamCopy: boolean;
  bitrateKbps: number | null;
}

export type ExtractAudioItemStatus = "extracted" | "no_audio" | "skipped" | "failed";

export interface ExtractAudioItemResult {
  sourcePath: string;
  fileName: string;
  audioTrackIndex: number;
  trackLanguage: string | null;
  status: ExtractAudioItemStatus;
  usedStreamCopy: boolean;
  outputPath: string | null;
  byteSize: number | null;
  durationSec: number | null;
  outputCodec: string | null;
  message: string | null;
}

export interface ExtractAudioBatchResponse {
  taskId: string;
  outputDir: string;
  cancelled: boolean;
  extractedCount: number;
  noAudioCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: ExtractAudioItemResult[];
}

export interface AudioTrackPreviewResult {
  previewUrl: string;
  audioTrackIndex: number;
  durationSec: number | null;
}

export async function muteVideosBatch(
  req: MuteVideosBatchRequest,
): Promise<MuteVideosBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<MuteVideosBatchResponse>("mute_videos_batch", { req });
}

export async function previewAudioTrack(
  path: string,
  audioTrackIndex: number,
): Promise<AudioTrackPreviewResult> {
  assertFrontendNotShuttingDown();
  return invoke<AudioTrackPreviewResult>("preview_audio_track", {
    path,
    audioTrackIndex,
  });
}

export async function extractAudioBatch(
  req: ExtractAudioBatchRequest,
): Promise<ExtractAudioBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ExtractAudioBatchResponse>("extract_audio_batch", { req });
}

// ---------- Phase 4A Batch 3: V04 Extract Frames & V15 Video to GIF ----------

export type FrameExtractMode = "single_time" | "interval_seconds" | "even_count";
export type FrameResolutionPreset = "original" | "p1080" | "p720";
export type FrameImageFormat = "png" | "jpeg" | "webp" | "heic";

export interface ExtractFramesRequest {
  taskId: string;
  sourcePath: string;
  outputDir: string;
  mode: FrameExtractMode;
  timestampSec?: number | null;
  intervalSec?: number | null;
  frameCount?: number | null;
  startSec?: number | null;
  endSec?: number | null;
  resolution: FrameResolutionPreset;
  format: FrameImageFormat;
  quality?: number | null;
}

export interface ExtractedFrameItem {
  index: number;
  timestampSec: number;
  outputPath: string;
  fileName: string;
  width: number;
  height: number;
  byteSize: number;
  thumbnailDataUrl: string;
}

export interface ExtractFramesResponse {
  taskId: string;
  outputDir: string;
  cancelled: boolean;
  extractedCount: number;
  requestedCount: number;
  elapsedMs: number;
  frames: ExtractedFrameItem[];
}

export type GifWidthPreset = "w320" | "w480" | "w640" | "original";

export interface ConvertVideoToGifRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  startSec?: number | null;
  endSec?: number | null;
  fps: 10 | 15 | 24;
  widthPreset: GifWidthPreset;
  loopForever: boolean;
  allowUpscale?: boolean;
  allowOverwrite?: boolean;
}

export interface ConvertVideoToGifResult {
  outputPath: string;
  previewUrl: string;
  byteSize: number;
  width: number;
  height: number;
  frameCount: number;
  durationSec: number;
  fps: number;
  loopForever: boolean;
  elapsedMs: number;
}

export async function extractVideoFrames(
  req: ExtractFramesRequest,
): Promise<ExtractFramesResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ExtractFramesResponse>("extract_video_frames", { req });
}

export async function convertVideoToGif(
  req: ConvertVideoToGifRequest,
): Promise<ConvertVideoToGifResult> {
  assertFrontendNotShuttingDown();
  return invoke<ConvertVideoToGifResult>("convert_video_to_gif", { req });
}

// ---------- Phase 4B1 PR 1: V07 Convert Video & V06 Compress Video ----------

export type VideoConvertFormat = "mp4" | "mov" | "webm" | "m4v" | "mkv";
export type TrackConvertAction = "copy" | "transcode" | "drop";
export type ConvertOverallMode = "remux_only" | "mixed" | "full_transcode";

export interface TrackConvertPlan {
  streamIndex: number;
  streamType: string;
  sourceCodec: string;
  language: string | null;
  title: string | null;
  action: TrackConvertAction;
  targetCodec: string | null;
  reasonCode: string;
  reasonText: string;
}

export interface VideoConvertPlan {
  sourcePath: string;
  fileName: string;
  byteSize: number;
  durationSec: number | null;
  sourceContainer: string | null;
  targetFormat: VideoConvertFormat;
  overallMode: ConvertOverallMode;
  copyTrackCount: number;
  transcodeTrackCount: number;
  dropTrackCount: number;
  hasContainerLimitations: boolean;
  limitationMessages: string[];
  tracks: TrackConvertPlan[];
}

export interface InspectVideoConvertPlanRequest {
  sourcePaths: string[];
  targetFormat: VideoConvertFormat;
}

export interface InspectVideoConvertPlanItem {
  sourcePath: string;
  fileName: string;
  ok: boolean;
  plan: VideoConvertPlan | null;
  error: string | null;
}

export interface InspectVideoConvertPlanResponse {
  targetFormat: VideoConvertFormat;
  items: InspectVideoConvertPlanItem[];
}

export interface ConvertVideosBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  targetFormat: VideoConvertFormat;
  allowDropIncompatible: boolean;
}

export type ConvertItemStatus = "converted" | "skipped" | "failed";

export interface ConvertVideoItemResult {
  sourcePath: string;
  fileName: string;
  status: ConvertItemStatus;
  outputPath: string | null;
  outputBytes: number | null;
  overallMode: ConvertOverallMode | null;
  verifiedContainer: string | null;
  verifiedVideoCodecs: string[];
  verifiedAudioCodecs: string[];
  verifiedSubtitleCodecs: string[];
  verifiedStreamCount: number | null;
  droppedTrackCount: number;
  elapsedMs: number;
  message: string | null;
}

export interface ConvertVideosBatchResponse {
  taskId: string;
  outputDir: string;
  targetFormat: VideoConvertFormat;
  cancelled: boolean;
  convertedCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: ConvertVideoItemResult[];
}

export type CompressQualityPreset = "high" | "balanced" | "small";
export type CompressVideoCodec = "h264" | "hevc";
export type CompressResolutionCap = "original" | "p1080" | "p720" | "p480";

export interface VideoEncoderOption {
  id: string;
  codec: CompressVideoCodec;
  isHardware: boolean;
  label: string;
}

export interface VideoEncoderCapabilities {
  ffmpegPath: string;
  h264Encoders: VideoEncoderOption[];
  hevcEncoders: VideoEncoderOption[];
  hasHardwareH264: boolean;
  hasHardwareHevc: boolean;
}

export interface CompressVideosBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  preset: CompressQualityPreset;
  codec: CompressVideoCodec;
  resolutionCap: CompressResolutionCap;
  encoderPreference?: string | null;
  keepAudio?: boolean;
  keepOriginalIfLarger?: boolean;
}

export type CompressItemStatus = "compressed" | "kept_original" | "skipped" | "failed";

export interface CompressVideoItemResult {
  sourcePath: string;
  fileName: string;
  status: CompressItemStatus;
  outputPath: string | null;
  originalBytes: number;
  outputBytes: number | null;
  attemptedCompressedBytes: number | null;
  savedBytes: number;
  savedPercent: number;
  keptOriginal: boolean;
  keptOriginalReason: string | null;
  actualEncoderUsed: string | null;
  usedHardwareEncoder: boolean;
  outputWidth: number | null;
  outputHeight: number | null;
  outputCodec: string | null;
  elapsedMs: number;
  message: string | null;
}

export interface CompressVideosBatchResponse {
  taskId: string;
  outputDir: string;
  cancelled: boolean;
  compressedCount: number;
  keptOriginalCount: number;
  skippedCount: number;
  failedCount: number;
  totalOriginalBytes: number;
  totalOutputBytes: number;
  totalSavedBytes: number;
  totalSavedPercent: number;
  elapsedMs: number;
  items: CompressVideoItemResult[];
}

export async function inspectVideoConvertPlan(
  req: InspectVideoConvertPlanRequest,
): Promise<InspectVideoConvertPlanResponse> {
  assertFrontendNotShuttingDown();
  return invoke<InspectVideoConvertPlanResponse>("inspect_video_convert_plan", { req });
}

export async function convertVideosBatch(
  req: ConvertVideosBatchRequest,
): Promise<ConvertVideosBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ConvertVideosBatchResponse>("convert_videos_batch", { req });
}

export async function probeVideoEncoders(): Promise<VideoEncoderCapabilities> {
  assertFrontendNotShuttingDown();
  return invoke<VideoEncoderCapabilities>("probe_video_encoders");
}

export async function compressVideosBatch(
  req: CompressVideosBatchRequest,
): Promise<CompressVideosBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<CompressVideosBatchResponse>("compress_videos_batch", { req });
}
