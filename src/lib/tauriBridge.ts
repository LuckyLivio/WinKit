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
      version: "0.18.0",
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
  sampleFmt?: string | null;
  bitsPerSample?: number | null;
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

// ---------- Phase 4B1 PR 2: V08 Resize Video & V09 Crop & Rotate Video ----------

export type VideoResizeMode = "fit" | "pad" | "fill" | "stretch";

export interface ResizeVideosBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  targetWidth: number;
  targetHeight: number;
  mode: VideoResizeMode;
  lockAspectRatio: boolean;
  preventUpscale?: boolean;
}

export type ResizeItemStatus = "resized" | "skipped" | "failed";

export interface ResizeVideoItemResult {
  sourcePath: string;
  fileName: string;
  status: ResizeItemStatus;
  outputPath: string | null;
  outputBytes: number | null;
  sourceDisplayWidth: number | null;
  sourceDisplayHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  outputRotation: number | null;
  elapsedMs: number;
  message: string | null;
}

export interface ResizeVideosBatchResponse {
  taskId: string;
  outputDir: string;
  cancelled: boolean;
  resizedCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: ResizeVideoItemResult[];
}

export interface OrientedPreviewFrame {
  dataUrl: string;
  displayWidth: number;
  displayHeight: number;
  timestampSec: number;
}

export interface CropRotateVideoRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  rotateCw: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  cropX: number;
  cropY: number;
  cropWidth: number;
  cropHeight: number;
  allowOverwrite?: boolean;
}

export interface CropRotateVideoResult {
  outputPath: string;
  byteSize: number;
  outputWidth: number;
  outputHeight: number;
  outputRotation: number | null;
  durationSec: number | null;
  elapsedMs: number;
}

export async function resizeVideosBatch(
  req: ResizeVideosBatchRequest,
): Promise<ResizeVideosBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ResizeVideosBatchResponse>("resize_videos_batch", { req });
}

export async function extractOrientedPreviewFrame(
  sourcePath: string,
  timestampSec?: number | null,
): Promise<OrientedPreviewFrame> {
  assertFrontendNotShuttingDown();
  return invoke<OrientedPreviewFrame>("extract_oriented_preview_frame", {
    sourcePath,
    timestampSec: timestampSec ?? null,
  });
}

export async function cropRotateVideo(req: CropRotateVideoRequest): Promise<CropRotateVideoResult> {
  assertFrontendNotShuttingDown();
  return invoke<CropRotateVideoResult>("crop_rotate_video", { req });
}

// ---------- Phase 4B1 PR 3: V03 Change Speed & V12 Merge Videos ----------

export interface ChangeVideoSpeedBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  speedFactor: number;
  preservePitch?: boolean;
  muteAudio?: boolean;
}

export type SpeedItemStatus = "completed" | "skipped" | "failed";

export interface ChangeVideoSpeedItemResult {
  sourcePath: string;
  fileName: string;
  status: SpeedItemStatus;
  outputPath: string | null;
  outputBytes: number | null;
  sourceDurationSec: number | null;
  outputDurationSec: number | null;
  hasOutputAudio: boolean;
  speedFactor: number;
  elapsedMs: number;
  message: string | null;
}

export interface ChangeVideoSpeedBatchResponse {
  taskId: string;
  outputDir: string;
  speedFactor: number;
  cancelled: boolean;
  completedCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: ChangeVideoSpeedItemResult[];
}

export type MergeResolutionPreset =
  "match_first" | "p1080" | "p720" | "vertical1080" | "square1080";

export type MergeFitMode = "pad" | "fill";

export interface MergeVideosRequest {
  taskId: string;
  sourcePaths: string[];
  outputPath: string;
  resolutionPreset: MergeResolutionPreset;
  fitMode?: MergeFitMode;
  allowOverwrite?: boolean;
}

export interface MergeVideosResult {
  outputPath: string;
  byteSize: number;
  clipCount: number;
  outputWidth: number;
  outputHeight: number;
  outputDurationSec: number | null;
  hasAudio: boolean;
  elapsedMs: number;
}

export async function changeVideoSpeedBatch(
  req: ChangeVideoSpeedBatchRequest,
): Promise<ChangeVideoSpeedBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ChangeVideoSpeedBatchResponse>("change_video_speed_batch", { req });
}

export async function mergeVideos(req: MergeVideosRequest): Promise<MergeVideosResult> {
  assertFrontendNotShuttingDown();
  return invoke<MergeVideosResult>("merge_videos", { req });
}

// ---------- Phase 4B2 PR 1: A03 Trim Audio & A05 Convert Audio ----------

export interface AudioWaveformPayload {
  sourcePath: string;
  fileName: string;
  durationSec: number;
  sampleRateHz: number | null;
  channels: number | null;
  codecName: string | null;
  bitsPerSample: number | null;
  analysisSampleRateHz: number;
  bucketCount: number;
  minPeaks: number[];
  maxPeaks: number[];
  auditionUrl: string;
  auditionTranscoded: boolean;
}

export interface TrimAudioRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  startSec: number;
  endSec: number;
  fadeInEnabled: boolean;
  fadeInSec: number;
  fadeOutEnabled: boolean;
  fadeOutSec: number;
  allowOverwrite?: boolean;
}

export interface TrimAudioResult {
  outputPath: string;
  byteSize: number;
  durationSec: number | null;
  outputCodec: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  requestedStartSec: number;
  requestedEndSec: number;
  appliedFadeInSec: number;
  appliedFadeOutSec: number;
  elapsedMs: number;
}

export type AudioConvertFormat = "mp3" | "m4a" | "wav" | "flac" | "aiff";
export type AudioBitDepthOption = "source" | "bits16" | "bits24" | "bits32_float";

export interface ConvertAudioBatchRequest {
  taskId: string;
  sourcePaths: string[];
  outputDir: string;
  targetFormat: AudioConvertFormat;
  bitrateKbps?: number | null;
  sampleRateHz?: number | null;
  bitDepth?: AudioBitDepthOption | null;
}

export type AudioConvertItemStatus = "converted" | "skipped" | "failed";

export interface ConvertAudioItemResult {
  sourcePath: string;
  fileName: string;
  status: AudioConvertItemStatus;
  outputPath: string | null;
  outputBytes: number | null;
  outputCodec: string | null;
  outputSampleRateHz: number | null;
  outputChannels: number | null;
  outputBitsPerSample: number | null;
  outputDurationSec: number | null;
  elapsedMs: number;
  message: string | null;
}

export interface ConvertAudioBatchResponse {
  taskId: string;
  outputDir: string;
  targetFormat: AudioConvertFormat;
  cancelled: boolean;
  convertedCount: number;
  skippedCount: number;
  failedCount: number;
  elapsedMs: number;
  items: ConvertAudioItemResult[];
}

export async function extractAudioWaveform(
  sourcePath: string,
  buckets?: number | null,
): Promise<AudioWaveformPayload> {
  assertFrontendNotShuttingDown();
  return invoke<AudioWaveformPayload>("extract_audio_waveform", {
    sourcePath,
    buckets: buckets ?? null,
  });
}

export async function trimAudioFile(req: TrimAudioRequest): Promise<TrimAudioResult> {
  assertFrontendNotShuttingDown();
  return invoke<TrimAudioResult>("trim_audio_file", { req });
}

export async function convertAudioBatch(
  req: ConvertAudioBatchRequest,
): Promise<ConvertAudioBatchResponse> {
  assertFrontendNotShuttingDown();
  return invoke<ConvertAudioBatchResponse>("convert_audio_batch", { req });
}

// ---------- Phase 4B2 PR 2: A01 Clean Up Audio & V14 Replace Audio ----------

export type AudioDenoiseLevel = "off" | "light" | "medium" | "strong";

export interface CleanUpAudioOptions {
  audioTrackIndex: number;
  denoiseLevel: AudioDenoiseLevel;
  highpassRumble: boolean;
  normalizeLoudness: boolean;
  targetLufs?: number | null;
  removeSilence: boolean;
}

export interface PreviewAudioCleanupRequest {
  sourcePath: string;
  startSec: number;
  durationSec?: number | null;
  options: CleanUpAudioOptions;
}

export interface PreviewAudioCleanupResult {
  beforeUrl: string;
  afterUrl: string;
  startSec: number;
  previewDurationSec: number;
  beforeLufs: number | null;
  beforeTruePeakDb: number | null;
  afterLufs: number | null;
  afterTruePeakDb: number | null;
  isAllSilence: boolean;
}

export interface CleanUpAudioRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  options: CleanUpAudioOptions;
  allowOverwrite?: boolean;
}

export interface CleanUpAudioResult {
  outputPath: string;
  byteSize: number;
  durationSec: number | null;
  hasVideo: boolean;
  videoStreamCopied: boolean;
  processedTrackIndex: number;
  totalAudioTracks: number;
  preservedOtherTracks: number;
  isAllSilence: boolean;
  silenceRemovalApplied: boolean;
  measuredBeforeLufs: number | null;
  measuredBeforeTruePeakDb: number | null;
  measuredAfterLufs: number | null;
  measuredAfterTruePeakDb: number | null;
  elapsedMs: number;
}

export type ReplaceAudioMode = "replace" | "mix";
export type ShortAudioBehavior = "loop_to_fill" | "play_once";

export interface ReplaceAudioOptions {
  videoPath: string;
  audioSourcePath: string;
  audioSourceTrackIndex: number;
  mode: ReplaceAudioMode;
  originalVolume: number;
  newAudioVolume: number;
  shortAudioBehavior: ShortAudioBehavior;
}

export interface PreviewReplaceAudioRequest {
  options: ReplaceAudioOptions;
  startSec?: number | null;
  maxDurationSec?: number | null;
}

export interface PreviewReplaceAudioResult {
  previewUrl: string;
  startSec: number;
  previewDurationSec: number;
  effectiveMode: ReplaceAudioMode;
}

export interface ReplaceAudioRequest {
  taskId: string;
  options: ReplaceAudioOptions;
  outputPath: string;
  allowOverwrite?: boolean;
}

export interface ReplaceAudioResult {
  outputPath: string;
  byteSize: number;
  durationSec: number | null;
  videoStreamCopied: boolean;
  effectiveMode: ReplaceAudioMode;
  targetVideoHadAudio: boolean;
  hasOutputAudio: boolean;
  elapsedMs: number;
}

export async function previewAudioCleanup(
  req: PreviewAudioCleanupRequest,
): Promise<PreviewAudioCleanupResult> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewAudioCleanupResult>("preview_audio_cleanup", { req });
}

export async function cleanUpAudio(req: CleanUpAudioRequest): Promise<CleanUpAudioResult> {
  assertFrontendNotShuttingDown();
  return invoke<CleanUpAudioResult>("clean_up_audio", { req });
}

export async function previewReplaceAudio(
  req: PreviewReplaceAudioRequest,
): Promise<PreviewReplaceAudioResult> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewReplaceAudioResult>("preview_replace_audio", { req });
}

export async function replaceVideoAudio(req: ReplaceAudioRequest): Promise<ReplaceAudioResult> {
  assertFrontendNotShuttingDown();
  return invoke<ReplaceAudioResult>("replace_video_audio", { req });
}

// ---------- Phase 4B2 PR 3: V02 Burn In Subtitles & I13 Video Watermark ----------

export type SubtitleFormat = "srt" | "web_vtt";
export type SubtitlePosition = "bottom" | "top";
export type SubtitleBoxStyle = "outline_shadow" | "black_box";

export interface SubtitleCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  sourceLine: number;
}

export interface ParsedSubtitleFile {
  path: string;
  fileName: string;
  format: SubtitleFormat;
  cueCount: number;
  totalDurationSec: number;
  cues: SubtitleCue[];
  warnings: string[];
}

export interface SubtitleBurnStyle {
  fontSize: number;
  position: SubtitlePosition;
  boxStyle: SubtitleBoxStyle;
  fontName?: string | null;
  marginV?: number | null;
}

export interface PreviewSubtitleFrameRequest {
  videoPath: string;
  subtitlePath: string;
  timestampSec: number;
  style: SubtitleBurnStyle;
}

export interface PreviewSubtitleFrameResult {
  dataUrl: string;
  timestampSec: number;
  activeCueIndices: number[];
  displayWidth: number;
  displayHeight: number;
}

export interface BurnInSubtitlesRequest {
  taskId: string;
  videoPath: string;
  subtitlePath: string;
  outputPath: string;
  style: SubtitleBurnStyle;
  allowOverwrite?: boolean;
}

export interface BurnInSubtitlesResult {
  outputPath: string;
  byteSize: number;
  outputWidth: number;
  outputHeight: number;
  outputRotation: number | null;
  durationSec: number | null;
  burnedCueCount: number;
  hasAudio: boolean;
  audioCopied: boolean;
  subtitleStreamsInOutput: number;
  elapsedMs: number;
}

export interface WatermarkVideoRequest {
  taskId: string;
  sourcePath: string;
  outputPath: string;
  style: WatermarkStyleConfig;
  allowOverwrite?: boolean;
}

export interface WatermarkVideoResult {
  outputPath: string;
  byteSize: number;
  outputWidth: number;
  outputHeight: number;
  outputRotation: number | null;
  durationSec: number | null;
  hasAudio: boolean;
  audioCopied: boolean;
  elapsedMs: number;
}

export async function parseSubtitleFile(path: string): Promise<ParsedSubtitleFile> {
  assertFrontendNotShuttingDown();
  return invoke<ParsedSubtitleFile>("parse_subtitle_file", { path });
}

export async function previewBurnedSubtitleFrame(
  req: PreviewSubtitleFrameRequest,
): Promise<PreviewSubtitleFrameResult> {
  assertFrontendNotShuttingDown();
  return invoke<PreviewSubtitleFrameResult>("preview_burned_subtitle_frame", { req });
}

export async function burnInSubtitles(req: BurnInSubtitlesRequest): Promise<BurnInSubtitlesResult> {
  assertFrontendNotShuttingDown();
  return invoke<BurnInSubtitlesResult>("burn_in_subtitles", { req });
}

export async function watermarkVideo(req: WatermarkVideoRequest): Promise<WatermarkVideoResult> {
  assertFrontendNotShuttingDown();
  return invoke<WatermarkVideoResult>("watermark_video", { req });
}

// ---------- Phase 4B2 Batch 2 PR 1: A02 Audio Recorder ----------

export type AudioEndpointFlow = "capture" | "render";

export interface AudioDeviceInfo {
  id: string;
  name: string;
  flow: AudioEndpointFlow;
  isDefault: boolean;
  sampleRate: number | null;
  channels: number | null;
  bitsPerSample: number | null;
}

export type RecorderPhase = "idle" | "monitoring" | "recording" | "paused" | "stopped_ready";
export type AudioRecordOutputFormat = "wav" | "m4a";

export interface AudioRecorderSnapshot {
  phase: RecorderPhase;
  deviceId: string | null;
  deviceName: string | null;
  sampleRate: number | null;
  channels: number | null;
  elapsedSec: number;
  levelRms: number;
  levelPeak: number;
  dbFs: number;
  clipping: boolean;
  previewUrl: string | null;
  tempWavPath: string | null;
  byteSize: number | null;
  interruptedReason: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface SaveAudioRecordingRequest {
  taskId: string;
  outputPath: string;
  format: AudioRecordOutputFormat;
  bitrateKbps?: number | null;
  allowOverwrite: boolean;
}

export interface SaveAudioRecordingResult {
  outputPath: string;
  format: AudioRecordOutputFormat;
  durationSec: number;
  sampleRate: number;
  channels: number;
  byteSize: number;
}

export async function listAudioCaptureDevices(): Promise<AudioDeviceInfo[]> {
  assertFrontendNotShuttingDown();
  return invoke<AudioDeviceInfo[]>("list_audio_capture_devices");
}

export async function getAudioRecorderStatus(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("get_audio_recorder_status");
}

export async function startAudioMonitor(deviceId?: string | null): Promise<AudioRecorderSnapshot> {
  assertFrontendNotShuttingDown();
  return invoke<AudioRecorderSnapshot>("start_audio_monitor", {
    deviceId: deviceId ?? null,
  });
}

export async function stopAudioMonitor(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("stop_audio_monitor");
}

export async function startAudioRecording(
  deviceId?: string | null,
): Promise<AudioRecorderSnapshot> {
  assertFrontendNotShuttingDown();
  return invoke<AudioRecorderSnapshot>("start_audio_recording", {
    deviceId: deviceId ?? null,
  });
}

export async function pauseAudioRecording(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("pause_audio_recording");
}

export async function resumeAudioRecording(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("resume_audio_recording");
}

export async function stopAudioRecording(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("stop_audio_recording");
}

export async function discardAudioRecording(): Promise<AudioRecorderSnapshot> {
  return invoke<AudioRecorderSnapshot>("discard_audio_recording");
}

export async function saveAudioRecording(
  req: SaveAudioRecordingRequest,
): Promise<SaveAudioRecordingResult> {
  assertFrontendNotShuttingDown();
  return invoke<SaveAudioRecordingResult>("save_audio_recording", { req });
}

export async function subscribeAudioRecorderState(
  handler: (payload: AudioRecorderSnapshot) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<AudioRecorderSnapshot>("winkit://audio-recorder-state", (event) => {
    handler(event.payload);
  });
}

// ---------- Phase 4B2 Batch 2 PR 2: V05 Screen Recorder ----------

export type ScreenRecordTargetKind = "monitor" | "window" | "region";
export type ScreenRecordResolution = "original" | "p1440" | "p1080" | "p720";
export type ScreenRecordFormat = "mp4" | "mov";
export type ScreenRecordPhase = "idle" | "recording" | "finalizing" | "completed" | "error";

export interface ScreenRecorderCapabilities {
  wgcSupported: boolean;
  cursorToggleSupported: boolean;
  clickHighlightSupported: boolean;
  formats: ScreenRecordFormat[];
  fpsOptions: number[];
  resolutionOptions: ScreenRecordResolution[];
}

export interface StartScreenRecordingRequest {
  targetKind: ScreenRecordTargetKind;
  monitorId?: string | null;
  windowHwnd?: number | null;
  regionRect?: CaptureRect | null;
  resolution: ScreenRecordResolution;
  fps: number;
  format: ScreenRecordFormat;
  includeCursor: boolean;
  highlightClicks: boolean;
  recordSystemAudio: boolean;
  systemAudioDeviceId?: string | null;
  recordMicrophone: boolean;
  microphoneDeviceId?: string | null;
  outputPath: string;
  allowOverwrite: boolean;
  showFloatingHud?: boolean | null;
}

export interface ScreenRecorderSnapshot {
  phase: ScreenRecordPhase;
  targetKind: ScreenRecordTargetKind | null;
  targetSummary: string | null;
  captureEngine?: string | null;
  audioScopeSummary: string | null;
  elapsedSec: number;
  framesWritten: number;
  outputWidth: number | null;
  outputHeight: number | null;
  fps: number | null;
  format: ScreenRecordFormat | null;
  recordSystemAudio: boolean;
  recordMicrophone: boolean;
  systemLevelDb: number;
  micLevelDb: number;
  outputPath: string | null;
  previewUrl: string | null;
  byteSize: number | null;
  durationSec: number | null;
  interruptedReason: string | null;
  warnings: string[];
  errorCode: string | null;
  errorMessage: string | null;
}

export async function listAudioPlaybackDevices(): Promise<AudioDeviceInfo[]> {
  assertFrontendNotShuttingDown();
  return invoke<AudioDeviceInfo[]>("list_audio_playback_devices");
}

export async function getScreenRecorderCapabilities(): Promise<ScreenRecorderCapabilities> {
  return invoke<ScreenRecorderCapabilities>("get_screen_recorder_capabilities");
}

export async function getScreenRecorderStatus(): Promise<ScreenRecorderSnapshot> {
  return invoke<ScreenRecorderSnapshot>("get_screen_recorder_status");
}

export async function pickScreenRecordingRegion(hideMainWindow = true): Promise<CaptureRect> {
  assertFrontendNotShuttingDown();
  return invoke<CaptureRect>("pick_screen_recording_region", { hideMainWindow });
}

export async function startScreenRecording(
  req: StartScreenRecordingRequest,
): Promise<ScreenRecorderSnapshot> {
  assertFrontendNotShuttingDown();
  return invoke<ScreenRecorderSnapshot>("start_screen_recording", { req });
}

export async function stopScreenRecording(): Promise<ScreenRecorderSnapshot> {
  return invoke<ScreenRecorderSnapshot>("stop_screen_recording");
}

export async function discardScreenRecording(): Promise<ScreenRecorderSnapshot> {
  return invoke<ScreenRecorderSnapshot>("discard_screen_recording");
}

export async function subscribeScreenRecorderState(
  handler: (payload: ScreenRecorderSnapshot) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<ScreenRecorderSnapshot>("winkit://screen-recorder-state", (event) => {
    handler(event.payload);
  });
}

// =============================================================================
// V01 Video Downloader & yt-dlp Setup
// =============================================================================

export type YtdlpMode = "auto" | "custom";
export type YtdlpSource = "managed" | "system_path" | "custom" | "missing";

export interface ManagedYtdlpSpec {
  version: string;
  sourceName: string;
  releaseUrl: string;
  downloadUrl: string;
  downloadBytes: number;
  sha256: string;
  licenseName: string;
}

export interface JsRuntimeInfo {
  name: string;
  path: string;
  version: string;
  recommended: boolean;
}

export interface YtdlpToolsStatus {
  ready: boolean;
  source: YtdlpSource;
  mode: YtdlpMode;
  customPath: string | null;
  ytdlpPath: string | null;
  ytdlpVersion: string | null;
  installDir: string;
  managedInstalledBytes: number | null;
  licensePath: string | null;
  jsRuntimes: JsRuntimeInfo[];
  hasJsRuntime: boolean;
  error: string | null;
  spec: ManagedYtdlpSpec;
}

export interface YtdlpSetupProgressPayload {
  taskId: string;
  phase: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number | null;
  message: string;
}

export type VideoDownloadQuality = "best" | "max_1080p" | "max_720p" | "audio_m4a";

export interface VideoDownloadFormatOption {
  formatId: string;
  ext: string;
  resolution: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  vcodec: string | null;
  acodec: string | null;
  language: string | null;
  filesizeBytes: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  note: string | null;
}

export interface VideoDownloadAudioTrackOption {
  language: string;
  label: string;
  codec: string | null;
}

export interface VideoDownloadProbeResult {
  sanitizedUrl: string;
  title: string;
  extractor: string;
  webpageDomain: string | null;
  durationSec: number | null;
  isDirectMedia: boolean;
  usedYtdlp: boolean;
  availableResolutions: number[];
  availableAudioLanguages: VideoDownloadAudioTrackOption[];
  hasH264: boolean;
  estimatedBestBytes: number | null;
  warnings: string[];
  formatsSummary: VideoDownloadFormatOption[];
}

export interface StartVideoDownloadItemRequest {
  taskId: string;
  itemId: string;
  url: string;
  outputDir: string;
  suggestedTitle?: string | null;
  quality: VideoDownloadQuality;
  preferH264: boolean;
  preferredAudioLanguage?: string | null;
}

export interface VideoDownloadProgressPayload {
  taskId: string;
  itemId: string;
  phase: string;
  percent: number | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
  speedBytesPerSec: number | null;
  etaSec: number | null;
  message: string | null;
}

export interface VideoDownloadItemResult {
  itemId: string;
  sanitizedUrl: string;
  outputPath: string;
  fileName: string;
  byteSize: number;
  sha256: string | null;
  title: string;
  extractor: string;
  usedYtdlp: boolean;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioLanguage: string | null;
  containerFormat: string | null;
  renamedForCollision: boolean;
  warnings: string[];
}

export async function getYtdlpToolsStatus(): Promise<YtdlpToolsStatus> {
  return invoke<YtdlpToolsStatus>("get_ytdlp_tools_status");
}

export async function setYtdlpCustomPath(path: string | null): Promise<YtdlpToolsStatus> {
  assertFrontendNotShuttingDown();
  return invoke<YtdlpToolsStatus>("set_ytdlp_custom_path", { path });
}

export async function installManagedYtdlp(taskId: string): Promise<YtdlpToolsStatus> {
  assertFrontendNotShuttingDown();
  return invoke<YtdlpToolsStatus>("install_managed_ytdlp", { taskId });
}

export async function subscribeYtdlpSetupProgress(
  handler: (payload: YtdlpSetupProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<YtdlpSetupProgressPayload>("winkit://ytdlp-setup-progress", (event) => {
    handler(event.payload);
  });
}

export async function probeVideoDownloadUrl(url: string): Promise<VideoDownloadProbeResult> {
  assertFrontendNotShuttingDown();
  return invoke<VideoDownloadProbeResult>("probe_video_download_url", { req: { url } });
}

export async function downloadVideoItem(
  req: StartVideoDownloadItemRequest,
): Promise<VideoDownloadItemResult> {
  assertFrontendNotShuttingDown();
  return invoke<VideoDownloadItemResult>("download_video_item", { req });
}

export async function subscribeVideoDownloadProgress(
  handler: (payload: VideoDownloadProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<VideoDownloadProgressPayload>("winkit://video-download-progress", (event) => {
    handler(event.payload);
  });
}

/* ==================== Phase 5A: Offline PDF Workbench (C08, P07–P12, P17) ==================== */

export interface PdfPageGeometry {
  pageNumber: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  isOversized: boolean;
}

export interface PdfOutlineItem {
  title: string;
  pageNumber: number | null;
  children: PdfOutlineItem[];
}

export interface PdfDocumentInspection {
  path: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  pages: PdfPageGeometry[];
  hasTextLayer: boolean;
  sampledTextPages: number;
  isLikelyScanned: boolean;
  hasOutlines: boolean;
  outlines: PdfOutlineItem[];
  hasAcroform: boolean;
  hasSignatures: boolean;
  signatureCount: number;
  isEncrypted: boolean;
  title: string | null;
  author: string | null;
  subject: string | null;
  creator: string | null;
  producer: string | null;
  warnings: string[];
}

export interface PdfRenderMeta {
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  pageWidthPt: number;
  pageHeightPt: number;
  rotation: number;
  capped: boolean;
}

export interface RenderedPdfPagePayload {
  meta: PdfRenderMeta;
  dataUrl: string;
  fromCache: boolean;
}

export interface PdfRenderRequest {
  path: string;
  pageNumber: number;
  targetWidthPx?: number;
  extraRotationCw?: number;
}

export interface PdfNormalizedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PdfTextSpan {
  text: string;
  rect: PdfNormalizedRect;
}

export interface PdfLinkItem {
  rect: PdfNormalizedRect;
  kind: "internal" | "external";
  targetPage: number | null;
  uri: string | null;
}

export interface PdfPageTextPayload {
  pageNumber: number;
  fullText: string;
  charCount: number;
  spans: PdfTextSpan[];
  links: PdfLinkItem[];
}

export interface PdfSearchMatch {
  pageNumber: number;
  matchIndex: number;
  snippet: string;
  rects: PdfNormalizedRect[];
}

export interface PdfSearchResult {
  query: string;
  totalMatches: number;
  truncated: boolean;
  matches: PdfSearchMatch[];
}

export interface PdfTaskProgressPayload {
  taskId: string;
  toolId: string;
  current: number;
  total: number;
  percent: number;
  detail: string;
}

export interface PdfStructuralSummary {
  preservedExternalLinks: number;
  remappedInternalLinks: number;
  droppedDanglingLinks: number;
  remappedBookmarks: number;
  droppedDanglingBookmarks: number;
  signatureInvalidatedSources: string[];
  acroformSimplifiedSources: string[];
}

export type PdfPageSizePreset = "original" | "a4" | "letter";
export type PdfPageOrientation = "auto" | "portrait" | "landscape";

export interface ImageToPdfPageOptions {
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  marginPt: number;
  backgroundHex: string;
  jpegQuality: number;
  losslessPngImages: boolean;
  assumedDpi: number;
}

export interface MergePdfInputItem {
  path: string;
  kind?: "pdf" | "image";
}

export interface MergePdfsRequest {
  taskId?: string;
  inputs: MergePdfInputItem[];
  outputPath: string;
  addFilenameBookmarks: boolean;
  overwrite?: boolean;
  imageOptions?: ImageToPdfPageOptions;
}

export interface MergePdfsResult {
  outputPath: string;
  byteLength: number;
  totalPages: number;
  sourceCount: number;
  pdfSourceCount: number;
  imageSourceCount: number;
  summary: PdfStructuralSummary;
  warnings: string[];
}

export type PdfSplitMode = "every_page" | "every_n_pages" | "custom_ranges";

export interface SplitPdfPlanRequest {
  path: string;
  mode: PdfSplitMode;
  chunkSize?: number;
  customRanges?: string;
  outputDir?: string;
}

export interface SplitPdfPlanItem {
  partIndex: number;
  fileName: string;
  pages: number[];
  pageCount: number;
  rangeLabel: string;
  collisionAdjusted: boolean;
}

export interface SplitPdfPlanPreview {
  valid: boolean;
  sourcePageCount: number;
  outputFileCount: number;
  totalOutputPages: number;
  items: SplitPdfPlanItem[];
  errors: string[];
  warnings: string[];
}

export interface SplitPdfRequest {
  taskId?: string;
  path: string;
  mode: PdfSplitMode;
  chunkSize?: number;
  customRanges?: string;
  outputDir: string;
}

export interface SplitPdfOutputFile {
  partIndex: number;
  path: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  rangeLabel: string;
  collisionAdjusted: boolean;
}

export interface SplitPdfResult {
  outputDir: string;
  sourcePageCount: number;
  files: SplitPdfOutputFile[];
  totalOutputPages: number;
  totalOutputBytes: number;
  cancelled: boolean;
  summary: PdfStructuralSummary;
  warnings: string[];
}

export async function inspectPdfDocument(path: string): Promise<PdfDocumentInspection> {
  assertFrontendNotShuttingDown();
  return invoke<PdfDocumentInspection>("inspect_pdf_document", { path });
}

export async function renderPdfPage(request: PdfRenderRequest): Promise<RenderedPdfPagePayload> {
  assertFrontendNotShuttingDown();
  return invoke<RenderedPdfPagePayload>("render_pdf_page", { request });
}

export async function getPdfPageText(
  path: string,
  pageNumber: number,
): Promise<PdfPageTextPayload> {
  assertFrontendNotShuttingDown();
  return invoke<PdfPageTextPayload>("get_pdf_page_text", { path, pageNumber });
}

export async function searchPdfText(
  path: string,
  query: string,
  caseSensitive = false,
): Promise<PdfSearchResult> {
  assertFrontendNotShuttingDown();
  return invoke<PdfSearchResult>("search_pdf_text", { path, query, caseSensitive });
}

export async function clearPdfRenderCache(): Promise<void> {
  if (!isTauriDesktop()) {
    return;
  }
  await invoke<void>("clear_pdf_render_cache");
}

export async function mergePdfs(request: MergePdfsRequest): Promise<MergePdfsResult> {
  assertFrontendNotShuttingDown();
  return invoke<MergePdfsResult>("merge_pdfs", { request });
}

export async function previewSplitPdfPlan(
  request: SplitPdfPlanRequest,
): Promise<SplitPdfPlanPreview> {
  assertFrontendNotShuttingDown();
  return invoke<SplitPdfPlanPreview>("preview_split_pdf_plan", { request });
}

export async function splitPdf(request: SplitPdfRequest): Promise<SplitPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<SplitPdfResult>("split_pdf", { request });
}

export async function subscribePdfTaskProgress(
  handler: (payload: PdfTaskProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<PdfTaskProgressPayload>("winkit://pdf-progress", (event) => {
    handler(event.payload);
  });
}

export interface OrganizePageSpec {
  sourcePage: number;
  extraRotationCw: number;
}

export interface OrganizePdfRequest {
  taskId?: string;
  path: string;
  pages: OrganizePageSpec[];
  outputPath: string;
  overwrite?: boolean;
}

export interface OrganizePdfResult {
  outputPath: string;
  byteLength: number;
  sourcePageCount: number;
  outputPageCount: number;
  rotatedPages: number;
  deletedPages: number;
  reordered: boolean;
  summary: PdfStructuralSummary;
  warnings: string[];
}

export interface DeletePdfPagesRequest {
  taskId?: string;
  path: string;
  deletePages: number[];
  outputPath: string;
  overwrite?: boolean;
}

export interface DeletePdfPagesResult {
  outputPath: string;
  byteLength: number;
  sourcePageCount: number;
  deletedPages: number[];
  keptPages: number[];
  summary: PdfStructuralSummary;
  warnings: string[];
}

export type PdfExtractMode = "single_pdf" | "per_page_pdfs";

export interface ExtractPdfPagesRequest {
  taskId?: string;
  path: string;
  pages: number[];
  mode: PdfExtractMode;
  dedupeAndSort?: boolean;
  outputPath?: string;
  outputDir?: string;
  overwrite?: boolean;
}

export interface ExtractPdfOutputFile {
  path: string;
  fileName: string;
  byteLength: number;
  pageCount: number;
  rangeLabel: string;
  collisionAdjusted: boolean;
}

export interface ExtractPdfPagesResult {
  mode: PdfExtractMode;
  sourcePageCount: number;
  extractedPages: number[];
  duplicatePagesRemoved: number;
  files: ExtractPdfOutputFile[];
  totalOutputBytes: number;
  cancelled: boolean;
  summary: PdfStructuralSummary;
  warnings: string[];
}

export async function organizePdf(request: OrganizePdfRequest): Promise<OrganizePdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<OrganizePdfResult>("organize_pdf", { request });
}

export async function deletePdfPages(
  request: DeletePdfPagesRequest,
): Promise<DeletePdfPagesResult> {
  assertFrontendNotShuttingDown();
  return invoke<DeletePdfPagesResult>("delete_pdf_pages", { request });
}

export async function extractPdfPages(
  request: ExtractPdfPagesRequest,
): Promise<ExtractPdfPagesResult> {
  assertFrontendNotShuttingDown();
  return invoke<ExtractPdfPagesResult>("extract_pdf_pages", { request });
}

export interface ImagesToPdfRequest {
  taskId?: string;
  imagePaths: string[];
  outputPath: string;
  overwrite?: boolean;
  pageSize: PdfPageSizePreset;
  orientation: PdfPageOrientation;
  marginPt: number;
  backgroundHex: string;
  jpegQuality?: number;
  losslessPngImages?: boolean;
  assumedDpi?: number;
}

export interface ImagePdfPageSummary {
  pageNumber: number;
  sourceFileName: string;
  widthPt: number;
  heightPt: number;
}

export interface ImagesToPdfResult {
  outputPath: string;
  byteLength: number;
  pageCount: number;
  pages: ImagePdfPageSummary[];
  warnings: string[];
}

export type PdfExportImageFormat = "png" | "jpeg" | "webp" | "heic";
export type PdfExportPageScope = "all" | "single_page" | "custom_range";

export interface PdfToImagesPlanRequest {
  path: string;
  scope: PdfExportPageScope;
  singlePage?: number;
  customRange?: string;
  dpi: number;
  format: PdfExportImageFormat;
}

export interface PdfToImagesPageEstimate {
  pageNumber: number;
  widthPx: number;
  heightPx: number;
  capped: boolean;
}

export interface PdfToImagesPlanPreview {
  valid: boolean;
  sourcePageCount: number;
  targetPageCount: number;
  maxWidthPx: number;
  maxHeightPx: number;
  cappedCount: number;
  heicEncodeAvailable: boolean;
  sampleEstimates: PdfToImagesPageEstimate[];
  errors: string[];
  warnings: string[];
}

export interface PdfToImagesRequest {
  taskId?: string;
  path: string;
  scope: PdfExportPageScope;
  singlePage?: number;
  customRange?: string;
  dpi: number;
  format: PdfExportImageFormat;
  quality?: number;
  webpLossless?: boolean;
  outputDir: string;
  createSubfolder?: boolean;
}

export interface PdfExportImageItemOutcome {
  pageNumber: number;
  status: "ok" | "error";
  outputPath: string | null;
  fileName: string | null;
  widthPx: number | null;
  heightPx: number | null;
  byteLength: number;
  capped: boolean;
  collisionAdjusted: boolean;
  errorMessage: string | null;
}

export interface PdfToImagesResult {
  outputDir: string;
  totalRequested: number;
  succeededCount: number;
  failedCount: number;
  cancelled: boolean;
  totalOutputBytes: number;
  items: PdfExportImageItemOutcome[];
  warnings: string[];
}

export async function imagesToPdf(request: ImagesToPdfRequest): Promise<ImagesToPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<ImagesToPdfResult>("images_to_pdf", { request });
}

export async function previewPdfToImagesPlan(
  request: PdfToImagesPlanRequest,
): Promise<PdfToImagesPlanPreview> {
  assertFrontendNotShuttingDown();
  return invoke<PdfToImagesPlanPreview>("preview_pdf_to_images_plan", { request });
}

export async function pdfToImages(request: PdfToImagesRequest): Promise<PdfToImagesResult> {
  assertFrontendNotShuttingDown();
  return invoke<PdfToImagesResult>("pdf_to_images", { request });
}

// ---------- Phase 5B PR 1: P06 Sign PDF, P13 Crop PDF, I13 PDF Watermark ----------

export interface PdfSignaturePlacement {
  pageNumber: number;
  xNorm: number;
  yNorm: number;
  widthNorm: number;
  heightNorm: number;
  rotationDeg: number;
  opacity: number;
  stampPngDataUrl?: string | null;
}

export interface SignPdfRequest {
  taskId?: string;
  path: string;
  outputPath: string;
  overwrite?: boolean;
  signaturePngDataUrl?: string | null;
  placements: PdfSignaturePlacement[];
}

export interface SignPdfResult {
  outputPath: string;
  byteLength: number;
  totalPages: number;
  signedPages: number[];
  placementCount: number;
  signatureInvalidated: boolean;
  warnings: string[];
}

export interface SignatureTemplateItem {
  id: string;
  name: string;
  createdAtMs: number;
  widthPx: number;
  heightPx: number;
  pngDataUrl: string;
}

export interface SignatureTemplatesListResponse {
  storageDir: string;
  items: SignatureTemplateItem[];
}

export interface SaveSignatureTemplateRequest {
  name: string;
  pngDataUrl: string;
}

export interface DetectWhiteMarginsRequest {
  path: string;
  pageNumber: number;
  paddingPt?: number;
}

export interface DetectedWhiteMargins {
  pageNumber: number;
  isBlank: boolean;
  pageWidthPt: number;
  pageHeightPt: number;
  leftPt: number;
  rightPt: number;
  topPt: number;
  bottomPt: number;
  leftNorm: number;
  topNorm: number;
  widthNorm: number;
  heightNorm: number;
}

export type PdfCropScope = "current" | "all" | "range";
export type PdfCropUnitsMode = "margins_pt" | "normalized_box";

export interface CropPdfRequest {
  taskId?: string;
  path: string;
  outputPath: string;
  overwrite?: boolean;
  scope: PdfCropScope;
  currentPage?: number;
  pageRange?: string;
  mode: PdfCropUnitsMode;
  leftPt?: number;
  rightPt?: number;
  topPt?: number;
  bottomPt?: number;
  leftNorm?: number;
  topNorm?: number;
  widthNorm?: number;
  heightNorm?: number;
}

export interface CroppedPageDimSummary {
  pageNumber: number;
  oldWidthPt: number;
  oldHeightPt: number;
  newWidthPt: number;
  newHeightPt: number;
}

export interface CropPdfResult {
  outputPath: string;
  byteLength: number;
  totalPages: number;
  croppedPageCount: number;
  samplePages: CroppedPageDimSummary[];
  signatureInvalidated: boolean;
  warnings: string[];
}

export type PdfWatermarkScope = "all" | "current" | "odd" | "even" | "range";

export interface WatermarkPdfRequest {
  taskId?: string;
  path: string;
  outputPath: string;
  overwrite?: boolean;
  scope: PdfWatermarkScope;
  currentPage?: number;
  pageRange?: string;
  style: WatermarkStyleConfig;
  singleAngleDeg?: number;
}

export interface WatermarkPdfResult {
  outputPath: string;
  byteLength: number;
  totalPages: number;
  watermarkedPageCount: number;
  signatureInvalidated: boolean;
  warnings: string[];
}

export async function listSignatureTemplates(): Promise<SignatureTemplatesListResponse> {
  assertFrontendNotShuttingDown();
  return invoke<SignatureTemplatesListResponse>("list_signature_templates");
}

export async function saveSignatureTemplate(
  request: SaveSignatureTemplateRequest,
): Promise<SignatureTemplateItem> {
  assertFrontendNotShuttingDown();
  return invoke<SignatureTemplateItem>("save_signature_template", { request });
}

export async function deleteSignatureTemplate(id: string): Promise<void> {
  assertFrontendNotShuttingDown();
  return invoke<void>("delete_signature_template", { id });
}

export async function signPdf(request: SignPdfRequest): Promise<SignPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<SignPdfResult>("sign_pdf", { request });
}

export async function detectPdfWhiteMargins(
  request: DetectWhiteMarginsRequest,
): Promise<DetectedWhiteMargins> {
  assertFrontendNotShuttingDown();
  return invoke<DetectedWhiteMargins>("detect_pdf_white_margins", { request });
}

export async function cropPdf(request: CropPdfRequest): Promise<CropPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<CropPdfResult>("crop_pdf", { request });
}

export async function watermarkPdf(request: WatermarkPdfRequest): Promise<WatermarkPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<WatermarkPdfResult>("watermark_pdf", { request });
}

// ---------- Phase 5B PR 2: P15 PDF Encrypt & P16 PDF Decrypt ----------

export type PdfSecurityStatusKind =
  | "unencrypted"
  | "encrypted_password_required"
  | "encrypted_owner_only"
  | "unsupported_security"
  | "corrupt_or_invalid";

export interface PdfSecurityStatus {
  path: string;
  fileName: string;
  byteLength: number;
  status: PdfSecurityStatusKind;
  isEncrypted: boolean;
  requiresOpenPassword: boolean;
  hasOwnerRestrictions: boolean;
  encryptionRevision: number | null;
  encryptionLabel: string | null;
  printPermission: string | null;
  allowCopy: boolean | null;
  allowModify: boolean | null;
  pageCount: number | null;
  hasSignatures: boolean;
  signatureCount: number;
  warnings: string[];
}

export type PdfPrintPermission = "none" | "low" | "full";
export type PdfModifyPermission = "none" | "annotate" | "all";

export interface EncryptPdfRequest {
  inputPath: string;
  outputPath: string;
  overwrite: boolean;
  userPassword: string;
  ownerPassword?: string | null;
  printPermission: PdfPrintPermission;
  allowCopy: boolean;
  allowModify: PdfModifyPermission;
  encryptMetadata?: boolean;
}

export interface EncryptPdfResult {
  outputPath: string;
  byteLength: number;
  pageCount: number;
  algorithm: string;
  hasOpenPassword: boolean;
  usedGeneratedOwnerPassword: boolean;
  printPermission: PdfPrintPermission;
  allowCopy: boolean;
  allowModify: PdfModifyPermission;
  signatureInvalidated: boolean;
  warnings: string[];
}

export interface DecryptPdfRequest {
  inputPath: string;
  outputPath: string;
  overwrite: boolean;
  password: string;
}

export interface DecryptPdfResult {
  outputPath: string;
  byteLength: number;
  pageCount: number;
  originalEncryption: string | null;
  verifiedOpenWithoutPassword: boolean;
  hasTextLayer: boolean;
  warnings: string[];
}

export async function inspectPdfSecurity(path: string): Promise<PdfSecurityStatus> {
  assertFrontendNotShuttingDown();
  return invoke<PdfSecurityStatus>("inspect_pdf_security", { path });
}

export async function encryptPdf(
  taskId: string,
  request: EncryptPdfRequest,
): Promise<EncryptPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<EncryptPdfResult>("encrypt_pdf", { taskId, request });
}

export async function decryptPdf(
  taskId: string,
  request: DecryptPdfRequest,
): Promise<DecryptPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<DecryptPdfResult>("decrypt_pdf", { taskId, request });
}

// ---------- Phase 5B PR 3: P14 PDF Compress & P23 Markdown to PDF ----------

export type PdfCompressMode = "lossless" | "balanced" | "smallest";

export interface CompressPdfRequest {
  inputPath: string;
  outputPath: string;
  overwrite: boolean;
  mode: PdfCompressMode;
}

export interface CompressPdfResult {
  outputPath: string;
  mode: PdfCompressMode;
  pageCount: number;
  originalBytes: number;
  outputBytes: number;
  savedBytes: number;
  savedPercent: number;
  keptOriginal: boolean;
  imagesInspected: number;
  imagesOptimized: number;
  imagesDownsampled: number;
  hasTextLayer: boolean;
  warnings: string[];
}

export type MarkdownTheme = "clean" | "github";
export type MarkdownPaperSize = "a4" | "letter";
export type MarkdownMarginPreset = "narrow" | "normal" | "wide";

export interface MarkdownHeadingInfo {
  level: number;
  title: string;
  slug: string;
}

export interface MarkdownPreviewRequest {
  markdown: string;
  sourceDir?: string | null;
  theme: MarkdownTheme;
  paperSize: MarkdownPaperSize;
  marginPreset: MarkdownMarginPreset;
  headerText?: string | null;
  footerText?: string | null;
  showPageNumbers: boolean;
  locale?: string | null;
}

export interface MarkdownPreviewResult {
  htmlDocument: string;
  headings: MarkdownHeadingInfo[];
  embeddedLocalImages: number;
  blockedRemoteImages: number;
  blockedLocalImages: number;
  strippedRawHtmlCount: number;
  warnings: string[];
}

export interface MarkdownToPdfRequest {
  markdown: string;
  sourceDir?: string | null;
  outputPath: string;
  overwrite: boolean;
  theme: MarkdownTheme;
  paperSize: MarkdownPaperSize;
  marginPreset: MarkdownMarginPreset;
  headerText?: string | null;
  footerText?: string | null;
  showPageNumbers: boolean;
  includeBookmarks: boolean;
  locale?: string | null;
}

export interface MarkdownToPdfResult {
  outputPath: string;
  byteLength: number;
  pageCount: number;
  bookmarkCount: number;
  embeddedLocalImages: number;
  blockedRemoteImages: number;
  blockedLocalImages: number;
  strippedRawHtmlCount: number;
  hasTextLayer: boolean;
  warnings: string[];
}

export async function compressPdf(
  taskId: string,
  request: CompressPdfRequest,
): Promise<CompressPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<CompressPdfResult>("compress_pdf", { taskId, request });
}

export async function renderMarkdownPreview(
  request: MarkdownPreviewRequest,
): Promise<MarkdownPreviewResult> {
  assertFrontendNotShuttingDown();
  return invoke<MarkdownPreviewResult>("render_markdown_preview", { request });
}

export async function exportMarkdownToPdf(
  taskId: string,
  request: MarkdownToPdfRequest,
): Promise<MarkdownToPdfResult> {
  assertFrontendNotShuttingDown();
  return invoke<MarkdownToPdfResult>("export_markdown_to_pdf", { taskId, request });
}

// ---------------------------------------------------------------------------
// Phase 6: Reusable Offline OCR Engine (T03, shared with future T04 & P04)
// ---------------------------------------------------------------------------

export interface OcrPoint {
  x: number;
  y: number;
}

export interface OcrNormPoint {
  x: number;
  y: number;
}

export interface OcrBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OcrSpan {
  text: string;
  bboxPx: OcrBoundingBox;
  bboxNorm: OcrBoundingBox;
  charStart: number;
  charEnd: number;
}

export interface OcrTextLine {
  index: number;
  rowIndex: number;
  text: string;
  confidence: number;
  quadPx: [OcrPoint, OcrPoint, OcrPoint, OcrPoint];
  quadNorm: [OcrNormPoint, OcrNormPoint, OcrNormPoint, OcrNormPoint];
  bboxPx: OcrBoundingBox;
  bboxNorm: OcrBoundingBox;
  angleDeg: number;
  rotated180: boolean;
  spans: OcrSpan[];
}

export interface OcrPageResult {
  pageNumber: number;
  imageWidthPx: number;
  imageHeightPx: number;
  renderDpi: number | null;
  sourceWidthPt: number | null;
  sourceHeightPt: number | null;
  text: string;
  lines: OcrTextLine[];
  lineCount: number;
  charCount: number;
  averageConfidence: number;
  elapsedMs: number;
  previewDataUrl: string | null;
  warnings: string[];
}

export interface OcrEngineStatus {
  ready: boolean;
  engineName: string;
  runtimeVersion: string | null;
  ocrDir: string | null;
  error: string | null;
}

export interface OcrRecognizeOptions {
  maxSideLen?: number;
  includePreview?: boolean;
}

export interface OcrProgressPayload {
  taskId: string;
  currentItem: number;
  totalItems: number;
  currentPage: number;
  totalPages: number;
  label: string;
  percent: number;
  state: string;
}

export interface OcrInspectSourceItem {
  path: string;
  fileName: string;
  kind: "image" | "pdf";
  byteLength: number;
  widthPx: number | null;
  heightPx: number | null;
  pageCount: number;
  isLikelyScanned: boolean;
  previewDataUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface OcrSourceInput {
  id: string;
  path?: string | null;
  assetId?: string | null;
  name?: string | null;
  pageRange?: string | null;
}

export interface OcrBatchRequest {
  items: OcrSourceInput[];
  pdfDpi?: number;
  options?: OcrRecognizeOptions;
}

export interface OcrBatchItemResult {
  sourceId: string;
  sourcePath: string | null;
  sourceName: string;
  kind: "image" | "pdf" | "clipboard";
  status: "completed" | "failed" | "cancelled";
  pages: OcrPageResult[];
  combinedText: string;
  totalLines: number;
  totalChars: number;
  averageConfidence: number;
  elapsedMs: number;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface OcrBatchResult {
  engineName: string;
  items: OcrBatchItemResult[];
  completedCount: number;
  failedCount: number;
  cancelled: boolean;
  totalPages: number;
  totalLines: number;
  totalChars: number;
  totalElapsedMs: number;
}

export async function getOcrEngineStatus(): Promise<OcrEngineStatus> {
  if (!isTauriDesktop()) {
    return {
      ready: false,
      engineName: "RapidOCR PP-OCRv4 mobile (ONNX Runtime CPU)",
      runtimeVersion: null,
      ocrDir: null,
      error: "Offline OCR requires the Windows desktop runtime.",
    };
  }
  return invoke<OcrEngineStatus>("get_ocr_engine_status");
}

export async function inspectOcrSources(paths: string[]): Promise<OcrInspectSourceItem[]> {
  assertFrontendNotShuttingDown();
  return invoke<OcrInspectSourceItem[]>("inspect_ocr_sources", { paths });
}

export async function ocrExtractBatch(
  taskId: string,
  request: OcrBatchRequest,
): Promise<OcrBatchResult> {
  assertFrontendNotShuttingDown();
  return invoke<OcrBatchResult>("ocr_extract_batch", { taskId, request });
}

export async function subscribeOcrProgress(
  handler: (payload: OcrProgressPayload) => void,
): Promise<UnlistenFn> {
  if (!isTauriDesktop()) {
    return () => {};
  }
  return listen<OcrProgressPayload>("winkit://ocr-progress", (event) => {
    handler(event.payload);
  });
}
