import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Hex8Interpretation, RgbaColor } from "../tools/color-picker/colorEngine";
import type { AnnotateToolKind, AnnotationItem } from "../tools/image-annotate/annotationRenderer";
import {
  DEFAULT_VIEWPORT,
  type PixelRect,
  type ViewportState,
} from "../tools/image-editor/canvasViewport";
import type {
  Base64WrapWidth,
  CodecFormat,
  CodecOperation,
  CodecTransformResponse,
} from "../tools/codec/codecEngine";
import type {
  AlgorithmDigestEntry,
  HashAlgorithm,
  HashBatchState,
} from "../tools/hash-generator/hashUtils";
import type { JwtExpectedAlgChoice, JwtSecretEncoding } from "../tools/jwt-decoder/jwtEngine";
import {
  DEFAULT_UNICODE_SANITIZE_OPTIONS,
  type UnicodeSanitizeOptions,
} from "../tools/unicode-inspector/unicodeEngine";
import type { LoremFormat, LoremUnit } from "../tools/lorem-ipsum/loremEngine";
import type {
  PassphraseSeparator,
  SecretStrengthEstimate,
} from "../tools/password-generator/passwordEngine";
import type {
  ConversionDirection,
  CsvDelimiter,
  CsvLineEnding,
  HeaderIssuePolicy,
  JsonArrayCellMode,
  PathConflictPolicy,
  RaggedRowPolicy,
} from "../tools/csv-json/csvJsonEngine";
import type {
  CoordinateOutputFormatId,
  PlainTextAxisOrder,
} from "../tools/coordinate-converter/coordinateEngine";
import type { BatchRenameSourceEntry } from "../tools/batch-rename/batchRenameEngine";
import {
  DEFAULT_RENAME_RULE,
  DEFAULT_RENAME_SORT,
  type RenameRule,
  type RenameSort,
} from "../tools/batch-rename/renameRulesModel";
import type {
  DuplicateRecycleResponse,
  DuplicateScanOptions,
  DuplicateScanProgressPayload,
  DuplicateScanResult,
} from "../tools/find-duplicates/findDuplicatesEngine";
import type {
  ArchiveCreateFormat,
  ArchivePreviewResponse,
  ArchiveProgressPayload,
  CreateArchiveRequest,
  CreateArchiveResponse,
  ExtractArchivesBatchResponse,
  ExtractArchivesRequest,
  ExtractConflictPolicy,
} from "../tools/archive/archiveModel";
import {
  DEFAULT_DOMAIN_MAPPINGS,
  type DomainMappingRule,
  type OrganizeExecuteResponse,
  type OrganizeNamingMode,
  type OrganizePreviewResponse,
} from "../tools/organize-downloads/organizeEngine";
import type {
  BatchImageJobResponse,
  CompressImagesBatchRequest,
  CompressQualityPreset,
  ConvertImagesBatchRequest,
  HeicCapabilities,
  ImageBatchProgressPayload,
  ImageConvertTargetFormat,
  InspectedImageItem,
  PngCompressMode,
  ResizeImagesBatchRequest,
  ResizeMode,
  RotateImagesBatchRequest,
  StripMetadataBatchRequest,
  TransformStep,
} from "../tools/image-batch/imageBatchModel";
import { formatCompactPages } from "../tools/pdf-shared/pageRangeUtils";
import {
  beautifyImagesBatch,
  bindDisposableListener,
  blurFacesBatch,
  cancelBackendTask,
  clearTtsSession,
  compressImagesBatch,
  convertImagesBatch,
  createArchive,
  extractArchivesBatch,
  getDefaultTtsMp3Bitrate,
  getSupportedTtsMp3Bitrates,
  inspectBeautifierSourceImage,
  listTtsVoices,
  parseBackendError,
  readClipboardImageAsAsset,
  readLocalTextFile,
  removeImageBackground,
  resizeImagesBatch,
  rotateImagesBatch,
  scanDuplicateFolders,
  stripImagesMetadataBatch,
  subscribeArchiveProgress,
  subscribeDuplicateScanProgress,
  subscribeImageBatchProgress,
  subscribeMattingProgress,
  subscribeTtsProgress,
  synthesizeTtsSpeech,
  watermarkImagesBatch,
  type BatchRenameSkippedItem,
  type BeautifyBackgroundKind,
  type BeautifyBatchRequest,
  type BlurFacesBatchRequest,
  type CaptureMonitorInfo,
  type CaptureProgressPayload,
  type CaptureResultPayload,
  type CaptureWindowInfo,
  type ImageAssetPayload,
  type ImagePaletteResult,
  type MattingBackgroundMode,
  type MattingExportFormat,
  type MattingProgressPayload,
  type RedactionKind,
  type RemoveBackgroundRequest,
  type RemoveBackgroundResult,
  type SaveAssetFormat,
  type ScreenColorSample,
  type SynthesizeTtsRequest,
  type SynthesizeTtsResult,
  type TtsExportFormat,
  type TtsProgressPayload,
  type TtsVoiceInfo,
  type WatermarkImagesBatchRequest,
  type WatermarkPlacement,
} from "./tauriBridge";

export type JsonIndentOption = "2" | "4" | "tab";
export type JsonModeOption = "format" | "minify" | "validate";

export interface JsonSessionState {
  inputText: string;
  indent: JsonIndentOption;
  sortKeys: boolean;
  mode: JsonModeOption;
  sourceFilePath: string | null;
}

export interface HashSessionState {
  mode: "text" | "file";
  selectedAlgorithms: HashAlgorithm[];
  uppercase: boolean;
  textInput: string;
  textDigests: AlgorithmDigestEntry[] | null;
  textStatus: "idle" | "completed" | "error";
  textErrorMessage: string | null;
  textExpectedHash: string;
  batch: HashBatchState | null;
  csvFormulaProtection: boolean;
}

export interface CodecSessionState {
  inputMode: "text" | "file";
  textInput: string;
  filePath: string | null;
  fileName: string | null;
  format: CodecFormat;
  operation: CodecOperation;
  padding: boolean;
  wrap: Base64WrapWidth;
  ignoreWhitespace: boolean;
  uppercaseHex: boolean;
  groupBits: boolean;
  result: CodecTransformResponse | null;
  errorMessage: string | null;
  savedMessage: string | null;
}

export interface UuidSessionState {
  version: "v4" | "v7";
  count: number;
  uppercase: boolean;
  hyphens: boolean;
  generatedList: string[];
  inspectInput: string;
}

export interface JwtSessionState {
  tokenInput: string;
  secretInput: string;
  secretEncoding: JwtSecretEncoding;
  expectedAlgorithm: JwtExpectedAlgChoice;
}

export type TimestampUnit = "s" | "ms" | "us" | "ns";

export interface TimestampSessionState {
  mode: "to_date" | "to_timestamp";
  timestampInput: string;
  unit: TimestampUnit;
  dateInput: string;
  inputTimezone: string;
  displayTimezone: string;
}

export interface DiffSessionState {
  leftText: string;
  rightText: string;
  leftFilePath: string | null;
  leftFileName: string | null;
  rightFilePath: string | null;
  rightFileName: string | null;
  viewMode: "side_by_side" | "inline";
  ignoreWhitespace: boolean;
  ignoreCase: boolean;
  dropTargetSide: "left" | "right";
  inputsCollapsed: boolean;
}

export interface RegexSessionState {
  pattern: string;
  flags: string;
  testText: string;
  sourceFileName: string | null;
  enableReplace: boolean;
  replacementTemplate: string;
}

export interface UnicodeSessionState {
  inputText: string;
  sourcePath: string | null;
  sourceFileName: string | null;
  attentionOnly: boolean;
  sanitizeOptions: UnicodeSanitizeOptions;
}

export interface CleanLinksSessionState {
  inputText: string;
}

export interface CoordinateSessionState {
  activeTab: "single" | "distance" | "batch";
  singleInputMode: "paste" | "separate";
  singleRawInput: string;
  separateLatInput: string;
  separateLonInput: string;
  plainAxisOrder: PlainTextAxisOrder;
  ddDecimals: string;
  dmDecimals: string;
  dmsDecimals: string;
  pointAInput: string;
  pointBInput: string;
  distanceAxisOrder: PlainTextAxisOrder;
  batchInputText: string;
  batchSourceFilePath: string | null;
  batchSourceFileName: string | null;
  batchOutputFormat: CoordinateOutputFormatId;
  batchCsvScope: "all_with_errors" | "valid_only";
  batchFormulaProtection: boolean;
}

export interface LoremIpsumSessionState {
  unit: LoremUnit;
  rawCount: string;
  format: LoremFormat;
  startWithClassic: boolean;
  seed: number;
}

export interface PasswordGeneratorSessionState {
  mode: "password" | "passphrase";
  rawLength: string;
  rawWordCount: string;
  rawBatchCount: string;
  uppercase: boolean;
  lowercase: boolean;
  digits: boolean;
  symbols: boolean;
  excludeLookAlikes: boolean;
  requireEachSelectedClass: boolean;
  separator: PassphraseSeparator;
  capitalizeWords: boolean;
  includeNumber: boolean;
  generatedItems: string[];
  generatedStrength: SecretStrengthEstimate | null;
  generatedConfigSignature: string | null;
  isStale: boolean;
}

export interface CsvJsonSessionState {
  inputText: string;
  sourceFilePath: string | null;
  sourceFileName: string | null;
  direction: ConversionDirection;
  delimiter: CsvDelimiter;
  firstRowHeaders: boolean;
  detectTypes: boolean;
  emptyCellsAsNull: boolean;
  headerIssuePolicy: HeaderIssuePolicy;
  raggedRowPolicy: RaggedRowPolicy;
  arrayMode: JsonArrayCellMode;
  pathConflictPolicy: PathConflictPolicy;
  formulaProtection: boolean;
  csvLineEnding: CsvLineEnding;
  csvIncludeBom: boolean;
  outputViewMode: "text" | "table";
}

export interface WordCounterSessionState {
  textInput: string;
}

export type CaseStyleId =
  | "uppercase"
  | "lowercase"
  | "title"
  | "sentence"
  | "camel"
  | "pascal"
  | "snake"
  | "constant"
  | "kebab"
  | "dot"
  | "alternating"
  | "inverse";

export interface CaseConverterSessionState {
  textInput: string;
  selectedStyle: CaseStyleId;
}

export type TtsSourceKind = "none" | "txt" | "pdf";

export interface TtsPdfHandoffPayload {
  path: string;
  fileName: string;
  text: string;
  pages: number[];
  skippedScannedPages: number[];
  truncated: boolean;
}

export interface TextToSpeechSessionState {
  sourceGeneration: number;
  loadingFile: boolean;
  text: string;
  sourceKind: TtsSourceKind;
  sourceFilePath: string | null;
  sourceFileName: string | null;
  sourcePageSummary: string | null;
  sourceSkippedScannedPages: number[];
  sourceTruncated: boolean;
  voices: TtsVoiceInfo[];
  voicesLoaded: boolean;
  voicesLoading: boolean;
  hasChineseVoice: boolean;
  hasEnglishVoice: boolean;
  selectedVoiceId: string;
  rate: number;
  status: "idle" | "running" | "done" | "error";
  activeTaskId: string | null;
  liveProgress: TtsProgressPayload | null;
  result: SynthesizeTtsResult | null;
  errorMessage: string | null;
  exportFormat: TtsExportFormat;
  mp3BitrateKbps: number;
  lastSavedMessage: string | null;
  lastSavedPath: string | null;
}

export type BeautifierAspect = "original" | "1:1" | "16:9" | "4:5" | "9:16";
export type ScreenCaptureMode = "region" | "window" | "monitor" | "scroll";
export type ImageHandoffTarget = "I02" | "I03" | "I04" | "I11" | "I12" | "I13";

export type RemoveBackgroundViewMode = "split" | "cutout" | "original";

export interface RemoveBackgroundSessionState {
  sourceGeneration: number;
  loadingSource: boolean;
  sourcePath: string | null;
  sourceAssetId: string | null;
  sourceFileName: string | null;
  sourcePreviewUrl: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  sourceHasAlpha: boolean;
  status: "idle" | "running" | "done" | "error";
  activeTaskId: string | null;
  liveProgress: MattingProgressPayload | null;
  result: RemoveBackgroundResult | null;
  errorMessage: string | null;
  viewMode: RemoveBackgroundViewMode;
  splitPercent: number;
  backgroundMode: MattingBackgroundMode;
  backgroundHex: string;
  exportFormat: MattingExportFormat;
  exportQuality: number;
  cropToSubject: boolean;
  cropPaddingPx: number;
  lastSavedMessage: string | null;
}

export interface ScreenCaptureSessionState {
  mode: ScreenCaptureMode;
  countdownSeconds: number;
  includeCursor: boolean;
  monitors: CaptureMonitorInfo[];
  selectedMonitorId: string;
  windows: CaptureWindowInfo[];
  selectedWindowHwnd: number | null;
  status: "idle" | "capturing";
  activeTaskId: string | null;
  liveProgress: CaptureProgressPayload | null;
  lastCapture: CaptureResultPayload | null;
  partialDecision: "pending" | "kept" | null;
  errorMessage: string | null;
}

export interface BeautifierSessionState {
  mode: "single" | "batch";
  sourcePath: string | null;
  assetId: string | null;
  sourceFileName: string | null;
  previewDataUrl: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  hasAlpha: boolean;
  backgroundKind: BeautifyBackgroundKind;
  backgroundColor: string;
  gradientStartHex: string;
  gradientEndHex: string;
  gradientAngleDeg: number;
  backgroundImagePath: string | null;
  backgroundImagePreviewUrl: string | null;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: BeautifierAspect;
  lastSavedMessage: string | null;
  batchItems: InspectedImageItem[];
  batchSelectedPath: string | null;
  batchOutputDir: string;
  batchStatus: "idle" | "running";
  batchActiveTaskId: string | null;
  batchLiveProgress: ImageBatchProgressPayload | null;
  batchLastReport: BatchImageJobResponse | null;
  batchErrorMessage: string | null;
}

export interface BatchRenameSessionState {
  entries: BatchRenameSourceEntry[];
  existingDirSiblings: Record<string, string[]>;
  skipped: BatchRenameSkippedItem[];
  rule: RenameRule;
  sort: RenameSort;
  filterMode: "all" | "changed" | "issues";
  lastBanner: { tone: "ok" | "warn" | "err"; text: string } | null;
}

export type DuplicateMinSizeUnit = "B" | "KiB" | "MiB";

export interface FindDuplicatesSessionState {
  rootPaths: string[];
  minSizeInput: string;
  minSizeUnit: DuplicateMinSizeUnit;
  includeHidden: boolean;
  preferredKeepFolder: string;
  status: "idle" | "scanning" | "recycling" | "completed" | "cancelled" | "error";
  activeTaskId: string | null;
  liveProgress: DuplicateScanProgressPayload | null;
  scanResult: DuplicateScanResult | null;
  selectedPaths: string[];
  lastRecycleReport: DuplicateRecycleResponse | null;
  errorMessage: string | null;
}

export interface ArchiveSessionState {
  activeTab: "extract" | "create";
  extractPaths: string[];
  extractPreviews: Record<string, ArchivePreviewResponse>;
  extractInspectErrors: Record<string, string>;
  selectedPreviewPath: string | null;
  outputParentDir: string;
  skipMacosMetadata: boolean;
  conflictPolicy: ExtractConflictPolicy;
  createSourcePaths: string[];
  createFormat: ArchiveCreateFormat;
  createOutputPath: string;
  status: "idle" | "extracting" | "creating";
  activeTaskId: string | null;
  liveProgress: ArchiveProgressPayload | null;
  lastExtractReport: ExtractArchivesBatchResponse | null;
  lastCreateReport: CreateArchiveResponse | null;
  errorMessage: string | null;
}

export interface OrganizeDownloadsSessionState {
  folderPath: string;
  namingMode: OrganizeNamingMode;
  moveUnknownToFolder: boolean;
  mappings: DomainMappingRule[];
  preview: OrganizePreviewResponse | null;
  lastExecution: OrganizeExecuteResponse | null;
  errorMessage: string | null;
}

export interface ImageConvertSessionState {
  items: InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  targetFormat: ImageConvertTargetFormat;
  quality: number;
  webpLossless: boolean;
  backgroundHex: string;
  heicCapabilities: HeicCapabilities | null;
  status: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
}

export interface ImageCompressSessionState {
  items: InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  qualityPreset: CompressQualityPreset;
  pngMode: PngCompressMode;
  status: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
}

export interface ImageResizeSessionState {
  items: InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  mode: ResizeMode;
  percentage: number;
  longestEdge: number;
  targetWidth: number;
  targetHeight: number;
  keepAspectRatio: boolean;
  preventUpscale: boolean;
  status: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
}

export interface ImageRotateSessionState {
  items: InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  steps: TransformStep[];
  status: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
}

export interface ImageMetadataSessionState {
  items: InspectedImageItem[];
  selectedPath: string | null;
  outputDir: string;
  keepOrientation: boolean;
  keepColorProfile: boolean;
  status: "idle" | "running";
  activeTaskId: string | null;
  liveProgress: ImageBatchProgressPayload | null;
  lastReport: BatchImageJobResponse | null;
  errorMessage: string | null;
}

export interface RedactRegionItem {
  id: string;
  kind: RedactionKind;
  x: number;
  y: number;
  width: number;
  height: number;
  strength: number;
  colorHex: string;
}

export interface ImageRedactSessionState {
  assetId: string | null;
  sourcePath: string | null;
  sourceFileName: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
  activeTool: "select" | RedactionKind;
  defaultStrength: number;
  defaultColorHex: string;
  stripMetadata: boolean;
  regions: RedactRegionItem[];
  undoStack: RedactRegionItem[][];
  redoStack: RedactRegionItem[][];
  selectedId: string | null;
  viewport: ViewportState;
  lastSavedMessage: string | null;
}

export interface ImageAnnotateSnapshot {
  items: AnnotationItem[];
  cropRect: PixelRect | null;
}

export interface ImageAnnotateSessionState {
  assetId: string | null;
  sourcePath: string | null;
  sourceFileName: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
  activeTool: AnnotateToolKind;
  color: string;
  highlightColor: string;
  strokeWidth: number;
  fontSize: number;
  textBackgroundPill: boolean;
  blurStrength: number;
  nextNumber: number;
  items: AnnotationItem[];
  cropRect: PixelRect | null;
  undoStack: ImageAnnotateSnapshot[];
  redoStack: ImageAnnotateSnapshot[];
  selectedId: string | null;
  viewport: ViewportState;
  lastSavedMessage: string | null;
}

export interface ImageWatermarkSessionState {
  mode: "single" | "batch" | "video" | "pdf";
  assetId: string | null;
  sourcePath: string | null;
  sourceFileName: string | null;
  previewDataUrl: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  kind: "text" | "logo";
  text: string;
  textColorHex: string;
  textBold: boolean;
  textShadow: boolean;
  logoPath: string | null;
  logoFileName: string | null;
  logoPreviewDataUrl: string | null;
  placement: WatermarkPlacement;
  scalePercent: number;
  marginPercent: number;
  opacityPercent: number;
  tileAngleDeg: number;
  tileSpacingPercent: number;
  lastSavedMessage: string | null;
  batchItems: InspectedImageItem[];
  batchSelectedPath: string | null;
  batchOutputDir: string;
  batchStatus: "idle" | "running";
  batchActiveTaskId: string | null;
  batchLiveProgress: ImageBatchProgressPayload | null;
  batchLastReport: BatchImageJobResponse | null;
  batchErrorMessage: string | null;
}

export interface BlurFaceBoxItem {
  id: string;
  source: "auto" | "manual";
  enabled: boolean;
  confidence: number | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BlurFaceItemStatus = "pending" | "detecting" | "detected" | "no_faces" | "failed";

export interface BlurFaceQueueEntry {
  id: string;
  sourcePath: string | null;
  fileName: string;
  assetId: string | null;
  dataUrl: string | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
  thumbnailDataUrl: string | null;
  detectionStatus: BlurFaceItemStatus;
  detectionError: string | null;
  detectedCount: number;
  elapsedMs: number | null;
  boxes: BlurFaceBoxItem[];
  undoStack: BlurFaceBoxItem[][];
  redoStack: BlurFaceBoxItem[][];
  modifiedByUser: boolean;
}

export interface BlurFacesSessionState {
  entries: BlurFaceQueueEntry[];
  activeEntryId: string | null;
  interactionMode: "select" | "add";
  selectedBoxId: string | null;
  redactionKind: RedactionKind;
  strength: number;
  colorHex: string;
  compareOriginal: boolean;
  stripMetadata: boolean;
  exportFormat: SaveAssetFormat;
  exportUntouchedCopies: boolean;
  outputDir: string;
  viewport: ViewportState;
  lastSavedMessage: string | null;
  batchStatus: "idle" | "running";
  batchActiveTaskId: string | null;
  batchLiveProgress: ImageBatchProgressPayload | null;
  batchLastReport: BatchImageJobResponse | null;
  batchErrorMessage: string | null;
}

export interface ColorHistoryItem {
  id: string;
  color: RgbaColor;
  hexLabel: string;
}

export interface ColorPickerSessionState {
  activeColor: RgbaColor;
  manualInput: string;
  hex8Order: Hex8Interpretation;
  lastSample: ScreenColorSample | null;
  history: ColorHistoryItem[];
  paletteImageName: string | null;
  paletteImagePath: string | null;
  paletteImageAssetId: string | null;
  paletteImagePreviewUrl: string | null;
  paletteMaxColors: number;
  paletteResult: ImagePaletteResult | null;
  contrastFg: RgbaColor;
  contrastFgInput: string;
  contrastBg: RgbaColor;
  contrastBgInput: string;
}

export interface SessionWorkspaces {
  json: JsonSessionState;
  hash: HashSessionState;
  codec: CodecSessionState;
  uuid: UuidSessionState;
  jwt: JwtSessionState;
  timestamp: TimestampSessionState;
  diff: DiffSessionState;
  regex: RegexSessionState;
  unicode: UnicodeSessionState;
  cleanLinks: CleanLinksSessionState;
  coordinate: CoordinateSessionState;
  loremIpsum: LoremIpsumSessionState;
  passwordGenerator: PasswordGeneratorSessionState;
  csvJson: CsvJsonSessionState;
  wordCounter: WordCounterSessionState;
  caseConverter: CaseConverterSessionState;
  textToSpeech: TextToSpeechSessionState;
  screenCapture: ScreenCaptureSessionState;
  blurFaces: BlurFacesSessionState;
  colorPicker: ColorPickerSessionState;
  beautifier: BeautifierSessionState;
  imageRedact: ImageRedactSessionState;
  imageAnnotate: ImageAnnotateSessionState;
  imageWatermark: ImageWatermarkSessionState;
  batchRename: BatchRenameSessionState;
  findDuplicates: FindDuplicatesSessionState;
  archive: ArchiveSessionState;
  organizeDownloads: OrganizeDownloadsSessionState;
  imageConvert: ImageConvertSessionState;
  imageCompress: ImageCompressSessionState;
  imageResize: ImageResizeSessionState;
  imageRotate: ImageRotateSessionState;
  imageMetadata: ImageMetadataSessionState;
  removeBackground: RemoveBackgroundSessionState;
}

const INITIAL_SESSION_STATE: SessionWorkspaces = {
  json: {
    inputText: "",
    indent: "2",
    sortKeys: false,
    mode: "format",
    sourceFilePath: null,
  },
  hash: {
    mode: "text",
    selectedAlgorithms: ["SHA-256"],
    uppercase: false,
    textInput: "",
    textDigests: null,
    textStatus: "idle",
    textErrorMessage: null,
    textExpectedHash: "",
    batch: null,
    csvFormulaProtection: false,
  },
  codec: {
    inputMode: "text",
    textInput: "",
    filePath: null,
    fileName: null,
    format: "base64_standard",
    operation: "encode",
    padding: true,
    wrap: "none",
    ignoreWhitespace: true,
    uppercaseHex: false,
    groupBits: true,
    result: null,
    errorMessage: null,
    savedMessage: null,
  },
  uuid: {
    version: "v4",
    count: 5,
    uppercase: false,
    hyphens: true,
    generatedList: [],
    inspectInput: "",
  },
  jwt: {
    tokenInput: "",
    secretInput: "",
    secretEncoding: "utf8",
    expectedAlgorithm: "auto",
  },
  timestamp: {
    mode: "to_date",
    timestampInput: "",
    unit: "s",
    dateInput: "",
    inputTimezone: "UTC",
    displayTimezone: "America/New_York",
  },
  diff: {
    leftText: "",
    rightText: "",
    leftFilePath: null,
    leftFileName: null,
    rightFilePath: null,
    rightFileName: null,
    viewMode: "side_by_side",
    ignoreWhitespace: false,
    ignoreCase: false,
    dropTargetSide: "left",
    inputsCollapsed: false,
  },
  regex: {
    pattern: "",
    flags: "gm",
    testText: "",
    sourceFileName: null,
    enableReplace: false,
    replacementTemplate: "",
  },
  unicode: {
    inputText: "",
    sourcePath: null,
    sourceFileName: null,
    attentionOnly: false,
    sanitizeOptions: { ...DEFAULT_UNICODE_SANITIZE_OPTIONS },
  },
  cleanLinks: {
    inputText: "",
  },
  coordinate: {
    activeTab: "single",
    singleInputMode: "paste",
    singleRawInput: "",
    separateLatInput: "",
    separateLonInput: "",
    plainAxisOrder: "lat_lon",
    ddDecimals: "6",
    dmDecimals: "3",
    dmsDecimals: "2",
    pointAInput: "",
    pointBInput: "",
    distanceAxisOrder: "lat_lon",
    batchInputText: "",
    batchSourceFilePath: null,
    batchSourceFileName: null,
    batchOutputFormat: "dd",
    batchCsvScope: "all_with_errors",
    batchFormulaProtection: false,
  },
  loremIpsum: {
    unit: "paragraphs",
    rawCount: "3",
    format: "plain",
    startWithClassic: true,
    seed: 0x20261118,
  },
  passwordGenerator: {
    mode: "password",
    rawLength: "16",
    rawWordCount: "6",
    rawBatchCount: "5",
    uppercase: true,
    lowercase: true,
    digits: true,
    symbols: true,
    excludeLookAlikes: true,
    requireEachSelectedClass: true,
    separator: "-",
    capitalizeWords: false,
    includeNumber: false,
    generatedItems: [],
    generatedStrength: null,
    generatedConfigSignature: null,
    isStale: false,
  },
  csvJson: {
    inputText: "",
    sourceFilePath: null,
    sourceFileName: null,
    direction: "csv_to_json",
    delimiter: "auto",
    firstRowHeaders: true,
    detectTypes: false,
    emptyCellsAsNull: false,
    headerIssuePolicy: "error",
    raggedRowPolicy: "error",
    arrayMode: "semicolon",
    pathConflictPolicy: "error",
    formulaProtection: false,
    csvLineEnding: "lf",
    csvIncludeBom: false,
    outputViewMode: "text",
  },
  wordCounter: {
    textInput: "",
  },
  caseConverter: {
    textInput: "",
    selectedStyle: "snake",
  },
  screenCapture: {
    mode: "region",
    countdownSeconds: 0,
    includeCursor: false,
    monitors: [],
    selectedMonitorId: "",
    windows: [],
    selectedWindowHwnd: null,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastCapture: null,
    partialDecision: null,
    errorMessage: null,
  },
  beautifier: {
    mode: "single",
    sourcePath: null,
    assetId: null,
    sourceFileName: null,
    previewDataUrl: null,
    sourceWidth: null,
    sourceHeight: null,
    hasAlpha: false,
    backgroundKind: "solid",
    backgroundColor: "#E8ECF2",
    gradientStartHex: "#DBEAFE",
    gradientEndHex: "#E0E7FF",
    gradientAngleDeg: 135,
    backgroundImagePath: null,
    backgroundImagePreviewUrl: null,
    padding: 48,
    cornerRadius: 12,
    shadowStrength: 28,
    aspectRatio: "original",
    lastSavedMessage: null,
    batchItems: [],
    batchSelectedPath: null,
    batchOutputDir: "",
    batchStatus: "idle",
    batchActiveTaskId: null,
    batchLiveProgress: null,
    batchLastReport: null,
    batchErrorMessage: null,
  },
  batchRename: {
    entries: [],
    existingDirSiblings: {},
    skipped: [],
    rule: DEFAULT_RENAME_RULE,
    sort: DEFAULT_RENAME_SORT,
    filterMode: "all",
    lastBanner: null,
  },
  findDuplicates: {
    rootPaths: [],
    minSizeInput: "0",
    minSizeUnit: "B",
    includeHidden: false,
    preferredKeepFolder: "",
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    scanResult: null,
    selectedPaths: [],
    lastRecycleReport: null,
    errorMessage: null,
  },
  archive: {
    activeTab: "extract",
    extractPaths: [],
    extractPreviews: {},
    extractInspectErrors: {},
    selectedPreviewPath: null,
    outputParentDir: "",
    skipMacosMetadata: true,
    conflictPolicy: "unique_folder",
    createSourcePaths: [],
    createFormat: "zip",
    createOutputPath: "",
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastExtractReport: null,
    lastCreateReport: null,
    errorMessage: null,
  },
  organizeDownloads: {
    folderPath: "",
    namingMode: "site_alias",
    moveUnknownToFolder: false,
    mappings: DEFAULT_DOMAIN_MAPPINGS.map((m) => ({ ...m })),
    preview: null,
    lastExecution: null,
    errorMessage: null,
  },
  imageConvert: {
    items: [],
    selectedPath: null,
    outputDir: "",
    targetFormat: "jpeg",
    quality: 88,
    webpLossless: false,
    backgroundHex: "#FFFFFF",
    heicCapabilities: null,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  imageCompress: {
    items: [],
    selectedPath: null,
    outputDir: "",
    qualityPreset: "medium",
    pngMode: "lossless",
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  imageResize: {
    items: [],
    selectedPath: null,
    outputDir: "",
    mode: "longest_edge",
    percentage: 50,
    longestEdge: 1920,
    targetWidth: 1280,
    targetHeight: 720,
    keepAspectRatio: true,
    preventUpscale: true,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  imageRotate: {
    items: [],
    selectedPath: null,
    outputDir: "",
    steps: [],
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  imageMetadata: {
    items: [],
    selectedPath: null,
    outputDir: "",
    keepOrientation: true,
    keepColorProfile: true,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    lastReport: null,
    errorMessage: null,
  },
  removeBackground: {
    sourceGeneration: 0,
    loadingSource: false,
    sourcePath: null,
    sourceAssetId: null,
    sourceFileName: null,
    sourcePreviewUrl: null,
    sourceWidth: null,
    sourceHeight: null,
    sourceHasAlpha: false,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    result: null,
    errorMessage: null,
    viewMode: "split",
    splitPercent: 50,
    backgroundMode: "transparent",
    backgroundHex: "#FFFFFF",
    exportFormat: "png",
    exportQuality: 92,
    cropToSubject: false,
    cropPaddingPx: 0,
    lastSavedMessage: null,
  },
  textToSpeech: {
    sourceGeneration: 0,
    loadingFile: false,
    text: "",
    sourceKind: "none",
    sourceFilePath: null,
    sourceFileName: null,
    sourcePageSummary: null,
    sourceSkippedScannedPages: [],
    sourceTruncated: false,
    voices: [],
    voicesLoaded: false,
    voicesLoading: false,
    hasChineseVoice: false,
    hasEnglishVoice: false,
    selectedVoiceId: "",
    rate: 1.0,
    status: "idle",
    activeTaskId: null,
    liveProgress: null,
    result: null,
    errorMessage: null,
    exportFormat: "wav",
    mp3BitrateKbps: 128,
    lastSavedMessage: null,
    lastSavedPath: null,
  },
  imageRedact: {
    assetId: null,
    sourcePath: null,
    sourceFileName: null,
    dataUrl: null,
    width: null,
    height: null,
    hasAlpha: false,
    activeTool: "solid",
    defaultStrength: 14,
    defaultColorHex: "#111827",
    stripMetadata: true,
    regions: [],
    undoStack: [],
    redoStack: [],
    selectedId: null,
    viewport: { ...DEFAULT_VIEWPORT },
    lastSavedMessage: null,
  },
  imageAnnotate: {
    assetId: null,
    sourcePath: null,
    sourceFileName: null,
    dataUrl: null,
    width: null,
    height: null,
    hasAlpha: false,
    activeTool: "arrow",
    color: "#DC2626",
    highlightColor: "#FDE047",
    strokeWidth: 4,
    fontSize: 22,
    textBackgroundPill: true,
    blurStrength: 14,
    nextNumber: 1,
    items: [],
    cropRect: null,
    undoStack: [],
    redoStack: [],
    selectedId: null,
    viewport: { ...DEFAULT_VIEWPORT },
    lastSavedMessage: null,
  },
  imageWatermark: {
    mode: "batch",
    assetId: null,
    sourcePath: null,
    sourceFileName: null,
    previewDataUrl: null,
    sourceWidth: null,
    sourceHeight: null,
    kind: "text",
    text: "WinKit 仅供审阅",
    textColorHex: "#FFFFFF",
    textBold: true,
    textShadow: true,
    logoPath: null,
    logoFileName: null,
    logoPreviewDataUrl: null,
    placement: "bottom_right",
    scalePercent: 24,
    marginPercent: 4,
    opacityPercent: 70,
    tileAngleDeg: -30,
    tileSpacingPercent: 110,
    lastSavedMessage: null,
    batchItems: [],
    batchSelectedPath: null,
    batchOutputDir: "",
    batchStatus: "idle",
    batchActiveTaskId: null,
    batchLiveProgress: null,
    batchLastReport: null,
    batchErrorMessage: null,
  },
  blurFaces: {
    entries: [],
    activeEntryId: null,
    interactionMode: "select",
    selectedBoxId: null,
    redactionKind: "blur",
    strength: 18,
    colorHex: "#111827",
    compareOriginal: false,
    stripMetadata: true,
    exportFormat: "png",
    exportUntouchedCopies: false,
    outputDir: "",
    viewport: { ...DEFAULT_VIEWPORT },
    lastSavedMessage: null,
    batchStatus: "idle",
    batchActiveTaskId: null,
    batchLiveProgress: null,
    batchLastReport: null,
    batchErrorMessage: null,
  },
  colorPicker: {
    activeColor: { r: 37, g: 99, b: 235, a: 1 },
    manualInput: "#2563EB",
    hex8Order: "css_rgba",
    lastSample: null,
    history: [],
    paletteImageName: null,
    paletteImagePath: null,
    paletteImageAssetId: null,
    paletteImagePreviewUrl: null,
    paletteMaxColors: 6,
    paletteResult: null,
    contrastFg: { r: 15, g: 23, b: 42, a: 1 },
    contrastFgInput: "#0F172A",
    contrastBg: { r: 255, g: 255, b: 255, a: 1 },
    contrastBgInput: "#FFFFFF",
  },
};

interface SessionStoreContextValue {
  session: SessionWorkspaces;
  updateJsonSession: (patch: Partial<JsonSessionState>) => void;
  updateHashSession: (
    patchOrUpdater: Partial<HashSessionState> | ((prev: HashSessionState) => HashSessionState),
  ) => void;
  updateCodecSession: (patch: Partial<CodecSessionState>) => void;
  updateUuidSession: (patch: Partial<UuidSessionState>) => void;
  updateJwtSession: (patch: Partial<JwtSessionState>) => void;
  updateTimestampSession: (patch: Partial<TimestampSessionState>) => void;
  updateDiffSession: (patch: Partial<DiffSessionState>) => void;
  updateRegexSession: (patch: Partial<RegexSessionState>) => void;
  updateUnicodeSession: (patch: Partial<UnicodeSessionState>) => void;
  updateCleanLinksSession: (patch: Partial<CleanLinksSessionState>) => void;
  updateCoordinateSession: (patch: Partial<CoordinateSessionState>) => void;
  updateLoremIpsumSession: (patch: Partial<LoremIpsumSessionState>) => void;
  updatePasswordGeneratorSession: (patch: Partial<PasswordGeneratorSessionState>) => void;
  updateCsvJsonSession: (patch: Partial<CsvJsonSessionState>) => void;
  updateWordCounterSession: (patch: Partial<WordCounterSessionState>) => void;
  updateCaseConverterSession: (patch: Partial<CaseConverterSessionState>) => void;
  updateScreenCaptureSession: (
    patchOrUpdater:
      | Partial<ScreenCaptureSessionState>
      | ((prev: ScreenCaptureSessionState) => ScreenCaptureSessionState),
  ) => void;
  updateBlurFacesSession: (
    patchOrUpdater:
      Partial<BlurFacesSessionState> | ((prev: BlurFacesSessionState) => BlurFacesSessionState),
  ) => void;
  startBlurFacesBatch: (
    req: BlurFacesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelBlurFacesBatch: () => Promise<void>;
  updateColorPickerSession: (
    patchOrUpdater:
      | Partial<ColorPickerSessionState>
      | ((prev: ColorPickerSessionState) => ColorPickerSessionState),
  ) => void;
  updateBeautifierSession: (
    patchOrUpdater:
      Partial<BeautifierSessionState> | ((prev: BeautifierSessionState) => BeautifierSessionState),
  ) => void;
  startBeautifyBatch: (
    req: BeautifyBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelBeautifyBatch: () => Promise<void>;
  updateImageRedactSession: (
    patchOrUpdater:
      | Partial<ImageRedactSessionState>
      | ((prev: ImageRedactSessionState) => ImageRedactSessionState),
  ) => void;
  updateImageAnnotateSession: (
    patchOrUpdater:
      | Partial<ImageAnnotateSessionState>
      | ((prev: ImageAnnotateSessionState) => ImageAnnotateSessionState),
  ) => void;
  updateImageWatermarkSession: (
    patchOrUpdater:
      | Partial<ImageWatermarkSessionState>
      | ((prev: ImageWatermarkSessionState) => ImageWatermarkSessionState),
  ) => void;
  startImageWatermarkBatch: (
    req: WatermarkImagesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageWatermarkBatch: () => Promise<void>;
  handoffImageToTool: (targetToolId: ImageHandoffTarget, asset: ImageAssetPayload) => void;
  updateBatchRenameSession: (
    patchOrUpdater:
      | Partial<BatchRenameSessionState>
      | ((prev: BatchRenameSessionState) => BatchRenameSessionState),
  ) => void;
  updateFindDuplicatesSession: (
    patchOrUpdater:
      | Partial<FindDuplicatesSessionState>
      | ((prev: FindDuplicatesSessionState) => FindDuplicatesSessionState),
  ) => void;
  startDuplicateScan: (
    options: DuplicateScanOptions,
    formatError: (err: unknown) => string,
  ) => Promise<void>;
  cancelDuplicateScan: () => Promise<void>;
  updateArchiveSession: (
    patchOrUpdater:
      Partial<ArchiveSessionState> | ((prev: ArchiveSessionState) => ArchiveSessionState),
  ) => void;
  startArchiveExtract: (
    request: ExtractArchivesRequest,
    formatError: (err: unknown) => string,
  ) => Promise<ExtractArchivesBatchResponse | null>;
  startArchiveCreate: (
    request: CreateArchiveRequest,
    formatError: (err: unknown) => string,
  ) => Promise<{ result: CreateArchiveResponse | null; errorCode: string | null }>;
  cancelArchiveTask: () => Promise<void>;
  updateOrganizeDownloadsSession: (
    patchOrUpdater:
      | Partial<OrganizeDownloadsSessionState>
      | ((prev: OrganizeDownloadsSessionState) => OrganizeDownloadsSessionState),
  ) => void;
  updateImageConvertSession: (
    patchOrUpdater:
      | Partial<ImageConvertSessionState>
      | ((prev: ImageConvertSessionState) => ImageConvertSessionState),
  ) => void;
  startImageConvertBatch: (
    req: ConvertImagesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageConvertBatch: () => Promise<void>;
  updateImageCompressSession: (
    patchOrUpdater:
      | Partial<ImageCompressSessionState>
      | ((prev: ImageCompressSessionState) => ImageCompressSessionState),
  ) => void;
  startImageCompressBatch: (
    req: CompressImagesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageCompressBatch: () => Promise<void>;
  updateImageResizeSession: (
    patchOrUpdater:
      | Partial<ImageResizeSessionState>
      | ((prev: ImageResizeSessionState) => ImageResizeSessionState),
  ) => void;
  startImageResizeBatch: (
    req: ResizeImagesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageResizeBatch: () => Promise<void>;
  updateImageRotateSession: (
    patchOrUpdater:
      | Partial<ImageRotateSessionState>
      | ((prev: ImageRotateSessionState) => ImageRotateSessionState),
  ) => void;
  startImageRotateBatch: (
    req: RotateImagesBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageRotateBatch: () => Promise<void>;
  updateImageMetadataSession: (
    patchOrUpdater:
      | Partial<ImageMetadataSessionState>
      | ((prev: ImageMetadataSessionState) => ImageMetadataSessionState),
  ) => void;
  startImageMetadataBatch: (
    req: StripMetadataBatchRequest,
    formatError: (err: unknown) => string,
  ) => Promise<BatchImageJobResponse | null>;
  cancelImageMetadataBatch: () => Promise<void>;
  updateRemoveBackgroundSession: (
    patchOrUpdater:
      | Partial<RemoveBackgroundSessionState>
      | ((prev: RemoveBackgroundSessionState) => RemoveBackgroundSessionState),
  ) => void;
  loadRemoveBackgroundFile: (
    rawPath: string,
    formatError: (err: unknown) => string,
  ) => Promise<boolean>;
  pasteRemoveBackgroundClipboard: (
    formatError: (err: unknown) => string,
    fallbackLabel: string,
  ) => Promise<boolean>;
  clearRemoveBackgroundSession: () => void;
  startRemoveBackground: (
    req: RemoveBackgroundRequest,
    formatError: (err: unknown) => string,
  ) => Promise<RemoveBackgroundResult | null>;
  cancelRemoveBackground: () => Promise<void>;
  updateTextToSpeechSession: (
    patchOrUpdater:
      | Partial<TextToSpeechSessionState>
      | ((prev: TextToSpeechSessionState) => TextToSpeechSessionState),
  ) => void;
  refreshTtsVoices: (formatError: (err: unknown) => string) => Promise<void>;
  loadTextToSpeechFile: (
    rawPath: string,
    formatError: (err: unknown) => string,
  ) => Promise<boolean>;
  handoffPdfTextToTts: (payload: TtsPdfHandoffPayload) => void;
  startTextToSpeech: (
    req: SynthesizeTtsRequest,
    formatError: (err: unknown) => string,
  ) => Promise<SynthesizeTtsResult | null>;
  cancelTextToSpeech: () => Promise<void>;
  clearTextToSpeechSession: () => void;
}

const SessionStoreContext = createContext<SessionStoreContextValue | null>(null);

export function SessionStoreProvider({
  children,
  onNavigateToTool,
}: {
  children: ReactNode;
  onNavigateToTool?: (toolId: string) => void;
}) {
  // Stored strictly in memory for the current process session; never persisted to disk.
  const [session, setSession] = useState<SessionWorkspaces>(INITIAL_SESSION_STATE);
  const navRef = useRef(onNavigateToTool);
  navRef.current = onNavigateToTool;

  const updateJsonSession = (patch: Partial<JsonSessionState>) => {
    setSession((prev) => ({ ...prev, json: { ...prev.json, ...patch } }));
  };

  const updateHashSession = useCallback(
    (
      patchOrUpdater: Partial<HashSessionState> | ((prev: HashSessionState) => HashSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        hash:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.hash)
            : { ...prev.hash, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateCodecSession = (patch: Partial<CodecSessionState>) => {
    setSession((prev) => ({ ...prev, codec: { ...prev.codec, ...patch } }));
  };

  const updateUuidSession = (patch: Partial<UuidSessionState>) => {
    setSession((prev) => ({ ...prev, uuid: { ...prev.uuid, ...patch } }));
  };

  const updateJwtSession = (patch: Partial<JwtSessionState>) => {
    setSession((prev) => ({ ...prev, jwt: { ...prev.jwt, ...patch } }));
  };

  const updateTimestampSession = (patch: Partial<TimestampSessionState>) => {
    setSession((prev) => ({ ...prev, timestamp: { ...prev.timestamp, ...patch } }));
  };

  const updateDiffSession = (patch: Partial<DiffSessionState>) => {
    setSession((prev) => ({ ...prev, diff: { ...prev.diff, ...patch } }));
  };

  const updateRegexSession = (patch: Partial<RegexSessionState>) => {
    setSession((prev) => ({ ...prev, regex: { ...prev.regex, ...patch } }));
  };

  const updateUnicodeSession = (patch: Partial<UnicodeSessionState>) => {
    setSession((prev) => ({ ...prev, unicode: { ...prev.unicode, ...patch } }));
  };

  const updateCleanLinksSession = (patch: Partial<CleanLinksSessionState>) => {
    setSession((prev) => ({ ...prev, cleanLinks: { ...prev.cleanLinks, ...patch } }));
  };

  const updateCoordinateSession = (patch: Partial<CoordinateSessionState>) => {
    setSession((prev) => ({ ...prev, coordinate: { ...prev.coordinate, ...patch } }));
  };

  const updateLoremIpsumSession = (patch: Partial<LoremIpsumSessionState>) => {
    setSession((prev) => ({ ...prev, loremIpsum: { ...prev.loremIpsum, ...patch } }));
  };

  const updatePasswordGeneratorSession = (patch: Partial<PasswordGeneratorSessionState>) => {
    setSession((prev) => ({
      ...prev,
      passwordGenerator: { ...prev.passwordGenerator, ...patch },
    }));
  };

  const updateCsvJsonSession = (patch: Partial<CsvJsonSessionState>) => {
    setSession((prev) => ({ ...prev, csvJson: { ...prev.csvJson, ...patch } }));
  };

  const updateWordCounterSession = (patch: Partial<WordCounterSessionState>) => {
    setSession((prev) => ({ ...prev, wordCounter: { ...prev.wordCounter, ...patch } }));
  };

  const updateCaseConverterSession = (patch: Partial<CaseConverterSessionState>) => {
    setSession((prev) => ({ ...prev, caseConverter: { ...prev.caseConverter, ...patch } }));
  };

  const updateScreenCaptureSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ScreenCaptureSessionState>
        | ((prev: ScreenCaptureSessionState) => ScreenCaptureSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        screenCapture:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.screenCapture)
            : { ...prev.screenCapture, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateBlurFacesSession = useCallback(
    (
      patchOrUpdater:
        Partial<BlurFacesSessionState> | ((prev: BlurFacesSessionState) => BlurFacesSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        blurFaces:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.blurFaces)
            : { ...prev.blurFaces, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateColorPickerSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ColorPickerSessionState>
        | ((prev: ColorPickerSessionState) => ColorPickerSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        colorPicker:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.colorPicker)
            : { ...prev.colorPicker, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateBeautifierSession = useCallback(
    (
      patchOrUpdater:
        | Partial<BeautifierSessionState>
        | ((prev: BeautifierSessionState) => BeautifierSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        beautifier:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.beautifier)
            : { ...prev.beautifier, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateImageRedactSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageRedactSessionState>
        | ((prev: ImageRedactSessionState) => ImageRedactSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageRedact:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageRedact)
            : { ...prev.imageRedact, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateImageAnnotateSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageAnnotateSessionState>
        | ((prev: ImageAnnotateSessionState) => ImageAnnotateSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageAnnotate:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageAnnotate)
            : { ...prev.imageAnnotate, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateImageWatermarkSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageWatermarkSessionState>
        | ((prev: ImageWatermarkSessionState) => ImageWatermarkSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageWatermark:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageWatermark)
            : { ...prev.imageWatermark, ...patchOrUpdater },
      }));
    },
    [],
  );

  const mattingRunSeqRef = useRef(1);
  const mattingSourceGenRef = useRef(0);
  const activeMattingTaskRef = useRef<string | null>(null);
  const ttsRunSeqRef = useRef(1);
  const ttsSourceGenRef = useRef(0);
  const ttsFileLoadSeqRef = useRef(0);
  const ttsVoiceRefreshSeqRef = useRef(0);
  const activeTtsTaskRef = useRef<string | null>(null);

  const handoffImageToTool = useCallback(
    (targetToolId: ImageHandoffTarget, asset: ImageAssetPayload) => {
      if (targetToolId === "I02") {
        const entryId = `mem-face-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const entry: BlurFaceQueueEntry = {
          id: entryId,
          sourcePath: null,
          fileName: asset.label || "image.png",
          assetId: asset.assetId,
          dataUrl: asset.dataUrl,
          width: asset.width,
          height: asset.height,
          hasAlpha: asset.hasAlpha,
          thumbnailDataUrl: asset.dataUrl,
          detectionStatus: "pending",
          detectionError: null,
          detectedCount: 0,
          elapsedMs: null,
          boxes: [],
          undoStack: [],
          redoStack: [],
          modifiedByUser: false,
        };
        setSession((prev) => ({
          ...prev,
          blurFaces: {
            ...prev.blurFaces,
            entries: [entry, ...prev.blurFaces.entries],
            activeEntryId: entryId,
            selectedBoxId: null,
            compareOriginal: false,
            viewport: { ...DEFAULT_VIEWPORT },
            lastSavedMessage: null,
          },
        }));
      } else if (targetToolId === "I03") {
        setSession((prev) => ({
          ...prev,
          beautifier: {
            ...prev.beautifier,
            mode: "single",
            sourcePath: null,
            assetId: asset.assetId,
            sourceFileName: asset.label,
            previewDataUrl: asset.dataUrl,
            sourceWidth: asset.width,
            sourceHeight: asset.height,
            hasAlpha: asset.hasAlpha,
            lastSavedMessage: null,
          },
        }));
      } else if (targetToolId === "I04") {
        const gen = ++mattingSourceGenRef.current;
        const runningId = activeMattingTaskRef.current;
        if (runningId) {
          activeMattingTaskRef.current = null;
          void cancelBackendTask(runningId);
        }
        setSession((prev) => ({
          ...prev,
          removeBackground: {
            ...prev.removeBackground,
            sourceGeneration: gen,
            loadingSource: false,
            sourcePath: null,
            sourceAssetId: asset.assetId,
            sourceFileName: asset.label,
            sourcePreviewUrl: asset.dataUrl,
            sourceWidth: asset.width,
            sourceHeight: asset.height,
            sourceHasAlpha: asset.hasAlpha,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            result: null,
            errorMessage: null,
            lastSavedMessage: null,
          },
        }));
      } else if (targetToolId === "I11") {
        setSession((prev) => ({
          ...prev,
          imageRedact: {
            ...prev.imageRedact,
            assetId: asset.assetId,
            sourcePath: null,
            sourceFileName: asset.label,
            dataUrl: asset.dataUrl,
            width: asset.width,
            height: asset.height,
            hasAlpha: asset.hasAlpha,
            regions: [],
            undoStack: [],
            redoStack: [],
            selectedId: null,
            viewport: { ...DEFAULT_VIEWPORT },
            lastSavedMessage: null,
          },
        }));
      } else if (targetToolId === "I12") {
        setSession((prev) => ({
          ...prev,
          imageAnnotate: {
            ...prev.imageAnnotate,
            assetId: asset.assetId,
            sourcePath: null,
            sourceFileName: asset.label,
            dataUrl: asset.dataUrl,
            width: asset.width,
            height: asset.height,
            hasAlpha: asset.hasAlpha,
            items: [],
            cropRect: null,
            undoStack: [],
            redoStack: [],
            selectedId: null,
            nextNumber: 1,
            viewport: { ...DEFAULT_VIEWPORT },
            lastSavedMessage: null,
          },
        }));
      } else if (targetToolId === "I13") {
        setSession((prev) => ({
          ...prev,
          imageWatermark: {
            ...prev.imageWatermark,
            mode: "single",
            assetId: asset.assetId,
            sourcePath: null,
            sourceFileName: asset.label,
            previewDataUrl: asset.dataUrl,
            sourceWidth: asset.width,
            sourceHeight: asset.height,
            lastSavedMessage: null,
          },
        }));
      }
      navRef.current?.(targetToolId);
    },
    [],
  );

  const updateBatchRenameSession = useCallback(
    (
      patchOrUpdater:
        | Partial<BatchRenameSessionState>
        | ((prev: BatchRenameSessionState) => BatchRenameSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        batchRename:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.batchRename)
            : { ...prev.batchRename, ...patchOrUpdater },
      }));
    },
    [],
  );

  const dupScanSeqRef = useRef(1);
  const activeDupTaskRef = useRef<string | null>(null);

  const updateFindDuplicatesSession = useCallback(
    (
      patchOrUpdater:
        | Partial<FindDuplicatesSessionState>
        | ((prev: FindDuplicatesSessionState) => FindDuplicatesSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        findDuplicates:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.findDuplicates)
            : { ...prev.findDuplicates, ...patchOrUpdater },
      }));
    },
    [],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeDuplicateScanProgress((payload) => {
          setSession((prev) => {
            if (prev.findDuplicates.activeTaskId !== payload.taskId) {
              return prev;
            }
            return {
              ...prev,
              findDuplicates: {
                ...prev.findDuplicates,
                liveProgress: payload,
              },
            };
          });
        }),
      "f03-session-scan-progress",
    );
  }, []);

  const startDuplicateScan = useCallback(
    async (options: DuplicateScanOptions, formatError: (err: unknown) => string) => {
      if (activeDupTaskRef.current) return;
      const taskId = `f03-scan-${Date.now()}-${dupScanSeqRef.current++}`;
      activeDupTaskRef.current = taskId;

      setSession((prev) => ({
        ...prev,
        findDuplicates: {
          ...prev.findDuplicates,
          status: "scanning",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            phase: "walking",
            scannedFiles: 0,
            candidateFiles: 0,
            processedBytes: 0,
            totalCandidateBytes: null,
            currentPath: options.rootPaths[0] ?? null,
          },
          scanResult: null,
          selectedPaths: [],
          lastRecycleReport: null,
          errorMessage: null,
        },
      }));

      try {
        const result = await scanDuplicateFolders(taskId, options);
        if (activeDupTaskRef.current !== taskId) return;
        activeDupTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          findDuplicates: {
            ...prev.findDuplicates,
            status: "completed",
            activeTaskId: null,
            liveProgress: null,
            scanResult: result,
            // Default: 0 items checked after scan
            selectedPaths: [],
            preferredKeepFolder:
              prev.findDuplicates.preferredKeepFolder || (result.effectiveRoots[0] ?? ""),
            errorMessage: null,
          },
        }));
      } catch (err) {
        if (activeDupTaskRef.current !== taskId) return;
        activeDupTaskRef.current = null;
        const parsed = parseBackendError(err);
        if (parsed.code === "TASK_CANCELLED") {
          setSession((prev) => ({
            ...prev,
            findDuplicates: {
              ...prev.findDuplicates,
              status: "cancelled",
              activeTaskId: null,
              liveProgress: null,
              errorMessage: null,
            },
          }));
        } else {
          setSession((prev) => ({
            ...prev,
            findDuplicates: {
              ...prev.findDuplicates,
              status: "error",
              activeTaskId: null,
              liveProgress: null,
              errorMessage: formatError(err),
            },
          }));
        }
      }
    },
    [],
  );

  const cancelDuplicateScan = useCallback(async () => {
    const taskId = activeDupTaskRef.current;
    if (!taskId) return;
    await cancelBackendTask(taskId);
  }, []);

  const archiveTaskSeqRef = useRef(1);
  const activeArchiveTaskRef = useRef<string | null>(null);

  const updateArchiveSession = useCallback(
    (
      patchOrUpdater:
        Partial<ArchiveSessionState> | ((prev: ArchiveSessionState) => ArchiveSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        archive:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.archive)
            : { ...prev.archive, ...patchOrUpdater },
      }));
    },
    [],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeArchiveProgress((payload) => {
          setSession((prev) => {
            if (prev.archive.activeTaskId !== payload.taskId) {
              return prev;
            }
            return {
              ...prev,
              archive: {
                ...prev.archive,
                liveProgress: payload,
              },
            };
          });
        }),
      "f04-session-archive-progress",
    );
  }, []);

  const startArchiveExtract = useCallback(
    async (
      request: ExtractArchivesRequest,
      formatError: (err: unknown) => string,
    ): Promise<ExtractArchivesBatchResponse | null> => {
      if (activeArchiveTaskRef.current) return null;
      const taskId = `f04-extract-${Date.now()}-${archiveTaskSeqRef.current++}`;
      activeArchiveTaskRef.current = taskId;

      setSession((prev) => ({
        ...prev,
        archive: {
          ...prev.archive,
          status: "extracting",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            operation: "extract",
            currentIndex: 1,
            totalItems: request.archivePaths.length,
            currentItem: request.archivePaths[0] ?? "",
            processedBytes: 0,
            totalBytes: null,
          },
          errorMessage: null,
        },
      }));

      try {
        const result = await extractArchivesBatch(taskId, request);
        if (activeArchiveTaskRef.current !== taskId) return null;
        activeArchiveTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          archive: {
            ...prev.archive,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastExtractReport: result,
            errorMessage: null,
          },
        }));
        return result;
      } catch (err) {
        if (activeArchiveTaskRef.current !== taskId) return null;
        activeArchiveTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          archive: {
            ...prev.archive,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const startArchiveCreate = useCallback(
    async (
      request: CreateArchiveRequest,
      formatError: (err: unknown) => string,
    ): Promise<{ result: CreateArchiveResponse | null; errorCode: string | null }> => {
      if (activeArchiveTaskRef.current) return { result: null, errorCode: null };
      const taskId = `f04-create-${Date.now()}-${archiveTaskSeqRef.current++}`;
      activeArchiveTaskRef.current = taskId;

      setSession((prev) => ({
        ...prev,
        archive: {
          ...prev.archive,
          status: "creating",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            operation: "create",
            currentIndex: 0,
            totalItems: request.sourcePaths.length,
            currentItem: request.sourcePaths[0] ?? "",
            processedBytes: 0,
            totalBytes: null,
          },
          lastCreateReport: null,
          errorMessage: null,
        },
      }));

      try {
        const result = await createArchive(taskId, request);
        if (activeArchiveTaskRef.current !== taskId) return { result: null, errorCode: null };
        activeArchiveTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          archive: {
            ...prev.archive,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastCreateReport: result,
            errorMessage: null,
          },
        }));
        return { result, errorCode: null };
      } catch (err) {
        if (activeArchiveTaskRef.current !== taskId) return { result: null, errorCode: null };
        activeArchiveTaskRef.current = null;
        const parsed = parseBackendError(err);
        setSession((prev) => ({
          ...prev,
          archive: {
            ...prev.archive,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: parsed.code === "TARGET_ALREADY_EXISTS" ? null : formatError(err),
          },
        }));
        return { result: null, errorCode: parsed.code };
      }
    },
    [],
  );

  const cancelArchiveTask = useCallback(async () => {
    const taskId = activeArchiveTaskRef.current;
    if (!taskId) return;
    await cancelBackendTask(taskId);
  }, []);

  const updateOrganizeDownloadsSession = useCallback(
    (
      patchOrUpdater:
        | Partial<OrganizeDownloadsSessionState>
        | ((prev: OrganizeDownloadsSessionState) => OrganizeDownloadsSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        organizeDownloads:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.organizeDownloads)
            : { ...prev.organizeDownloads, ...patchOrUpdater },
      }));
    },
    [],
  );

  const imgBatchSeqRef = useRef(1);
  const activeConvertTaskRef = useRef<string | null>(null);
  const activeCompressTaskRef = useRef<string | null>(null);
  const activeResizeTaskRef = useRef<string | null>(null);
  const activeRotateTaskRef = useRef<string | null>(null);
  const activeMetadataTaskRef = useRef<string | null>(null);
  const activeBeautifyBatchTaskRef = useRef<string | null>(null);
  const activeWatermarkBatchTaskRef = useRef<string | null>(null);
  const activeBlurFacesBatchTaskRef = useRef<string | null>(null);

  const updateImageConvertSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageConvertSessionState>
        | ((prev: ImageConvertSessionState) => ImageConvertSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageConvert:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageConvert)
            : { ...prev.imageConvert, ...patchOrUpdater },
      }));
    },
    [],
  );

  const updateImageCompressSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageCompressSessionState>
        | ((prev: ImageCompressSessionState) => ImageCompressSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageCompress:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageCompress)
            : { ...prev.imageCompress, ...patchOrUpdater },
      }));
    },
    [],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeImageBatchProgress((payload) => {
          setSession((prev) => {
            if (prev.imageConvert.activeTaskId === payload.taskId) {
              return {
                ...prev,
                imageConvert: { ...prev.imageConvert, liveProgress: payload },
              };
            }
            if (prev.imageCompress.activeTaskId === payload.taskId) {
              return {
                ...prev,
                imageCompress: { ...prev.imageCompress, liveProgress: payload },
              };
            }
            if (prev.imageResize.activeTaskId === payload.taskId) {
              return {
                ...prev,
                imageResize: { ...prev.imageResize, liveProgress: payload },
              };
            }
            if (prev.imageRotate.activeTaskId === payload.taskId) {
              return {
                ...prev,
                imageRotate: { ...prev.imageRotate, liveProgress: payload },
              };
            }
            if (prev.imageMetadata.activeTaskId === payload.taskId) {
              return {
                ...prev,
                imageMetadata: { ...prev.imageMetadata, liveProgress: payload },
              };
            }
            if (prev.beautifier.batchActiveTaskId === payload.taskId) {
              return {
                ...prev,
                beautifier: { ...prev.beautifier, batchLiveProgress: payload },
              };
            }
            if (prev.imageWatermark.batchActiveTaskId === payload.taskId) {
              return {
                ...prev,
                imageWatermark: { ...prev.imageWatermark, batchLiveProgress: payload },
              };
            }
            if (prev.blurFaces.batchActiveTaskId === payload.taskId) {
              return {
                ...prev,
                blurFaces: { ...prev.blurFaces, batchLiveProgress: payload },
              };
            }
            return prev;
          });
        }),
      "img-batch-progress",
    );
  }, []);

  const startImageConvertBatch = useCallback(
    async (
      req: ConvertImagesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeConvertTaskRef.current) return null;
      const taskId = `i05-convert-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeConvertTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageConvert: {
          ...prev.imageConvert,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I05",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await convertImagesBatch(taskId, req);
        if (activeConvertTaskRef.current !== taskId) return null;
        activeConvertTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageConvert: {
            ...prev.imageConvert,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeConvertTaskRef.current !== taskId) return null;
        activeConvertTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageConvert: {
            ...prev.imageConvert,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageConvertBatch = useCallback(async () => {
    const tid = activeConvertTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const startImageCompressBatch = useCallback(
    async (
      req: CompressImagesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeCompressTaskRef.current) return null;
      const taskId = `i06-compress-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeCompressTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageCompress: {
          ...prev.imageCompress,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I06",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await compressImagesBatch(taskId, req);
        if (activeCompressTaskRef.current !== taskId) return null;
        activeCompressTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageCompress: {
            ...prev.imageCompress,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeCompressTaskRef.current !== taskId) return null;
        activeCompressTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageCompress: {
            ...prev.imageCompress,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageCompressBatch = useCallback(async () => {
    const tid = activeCompressTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateImageResizeSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageResizeSessionState>
        | ((prev: ImageResizeSessionState) => ImageResizeSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageResize:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageResize)
            : { ...prev.imageResize, ...patchOrUpdater },
      }));
    },
    [],
  );

  const startImageResizeBatch = useCallback(
    async (
      req: ResizeImagesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeResizeTaskRef.current) return null;
      const taskId = `i07-resize-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeResizeTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageResize: {
          ...prev.imageResize,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I07",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await resizeImagesBatch(taskId, req);
        if (activeResizeTaskRef.current !== taskId) return null;
        activeResizeTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageResize: {
            ...prev.imageResize,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeResizeTaskRef.current !== taskId) return null;
        activeResizeTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageResize: {
            ...prev.imageResize,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageResizeBatch = useCallback(async () => {
    const tid = activeResizeTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateImageRotateSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageRotateSessionState>
        | ((prev: ImageRotateSessionState) => ImageRotateSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageRotate:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageRotate)
            : { ...prev.imageRotate, ...patchOrUpdater },
      }));
    },
    [],
  );

  const startImageRotateBatch = useCallback(
    async (
      req: RotateImagesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeRotateTaskRef.current) return null;
      const taskId = `i08-rotate-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeRotateTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageRotate: {
          ...prev.imageRotate,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I08",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await rotateImagesBatch(taskId, req);
        if (activeRotateTaskRef.current !== taskId) return null;
        activeRotateTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageRotate: {
            ...prev.imageRotate,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeRotateTaskRef.current !== taskId) return null;
        activeRotateTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageRotate: {
            ...prev.imageRotate,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageRotateBatch = useCallback(async () => {
    const tid = activeRotateTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateImageMetadataSession = useCallback(
    (
      patchOrUpdater:
        | Partial<ImageMetadataSessionState>
        | ((prev: ImageMetadataSessionState) => ImageMetadataSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        imageMetadata:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.imageMetadata)
            : { ...prev.imageMetadata, ...patchOrUpdater },
      }));
    },
    [],
  );

  const startImageMetadataBatch = useCallback(
    async (
      req: StripMetadataBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeMetadataTaskRef.current) return null;
      const taskId = `i09-metadata-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeMetadataTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageMetadata: {
          ...prev.imageMetadata,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            toolId: "I09",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          errorMessage: null,
        },
      }));
      try {
        const res = await stripImagesMetadataBatch(taskId, req);
        if (activeMetadataTaskRef.current !== taskId) return null;
        activeMetadataTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageMetadata: {
            ...prev.imageMetadata,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            lastReport: res,
            errorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeMetadataTaskRef.current !== taskId) return null;
        activeMetadataTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageMetadata: {
            ...prev.imageMetadata,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            errorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageMetadataBatch = useCallback(async () => {
    const tid = activeMetadataTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const startBeautifyBatch = useCallback(
    async (
      req: BeautifyBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeBeautifyBatchTaskRef.current) return null;
      const taskId = `i03-beautify-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeBeautifyBatchTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        beautifier: {
          ...prev.beautifier,
          batchStatus: "running",
          batchActiveTaskId: taskId,
          batchLiveProgress: {
            taskId,
            toolId: "I03",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          batchErrorMessage: null,
        },
      }));
      try {
        const res = await beautifyImagesBatch(taskId, req);
        if (activeBeautifyBatchTaskRef.current !== taskId) return null;
        activeBeautifyBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          beautifier: {
            ...prev.beautifier,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchLastReport: res,
            batchErrorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeBeautifyBatchTaskRef.current !== taskId) return null;
        activeBeautifyBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          beautifier: {
            ...prev.beautifier,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchErrorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelBeautifyBatch = useCallback(async () => {
    const tid = activeBeautifyBatchTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const startImageWatermarkBatch = useCallback(
    async (
      req: WatermarkImagesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeWatermarkBatchTaskRef.current) return null;
      const taskId = `i13-watermark-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeWatermarkBatchTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        imageWatermark: {
          ...prev.imageWatermark,
          batchStatus: "running",
          batchActiveTaskId: taskId,
          batchLiveProgress: {
            taskId,
            toolId: "I13",
            currentIndex: 1,
            totalItems: req.sourcePaths.length,
            currentFileName: req.sourcePaths[0] ?? "",
          },
          batchErrorMessage: null,
        },
      }));
      try {
        const res = await watermarkImagesBatch(taskId, req);
        if (activeWatermarkBatchTaskRef.current !== taskId) return null;
        activeWatermarkBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageWatermark: {
            ...prev.imageWatermark,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchLastReport: res,
            batchErrorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeWatermarkBatchTaskRef.current !== taskId) return null;
        activeWatermarkBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          imageWatermark: {
            ...prev.imageWatermark,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchErrorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelImageWatermarkBatch = useCallback(async () => {
    const tid = activeWatermarkBatchTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const startBlurFacesBatch = useCallback(
    async (
      req: BlurFacesBatchRequest,
      formatError: (err: unknown) => string,
    ): Promise<BatchImageJobResponse | null> => {
      if (activeBlurFacesBatchTaskRef.current) return null;
      const taskId = `i02-faces-${Date.now()}-${imgBatchSeqRef.current++}`;
      activeBlurFacesBatchTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        blurFaces: {
          ...prev.blurFaces,
          batchStatus: "running",
          batchActiveTaskId: taskId,
          batchLiveProgress: {
            taskId,
            toolId: "I02",
            currentIndex: 1,
            totalItems: req.items.length,
            currentFileName: req.items[0]?.sourcePath ?? "",
          },
          batchErrorMessage: null,
        },
      }));
      try {
        const res = await blurFacesBatch(taskId, req);
        if (activeBlurFacesBatchTaskRef.current !== taskId) return null;
        activeBlurFacesBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          blurFaces: {
            ...prev.blurFaces,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchLastReport: res,
            batchErrorMessage: null,
          },
        }));
        return res;
      } catch (err) {
        if (activeBlurFacesBatchTaskRef.current !== taskId) return null;
        activeBlurFacesBatchTaskRef.current = null;
        setSession((prev) => ({
          ...prev,
          blurFaces: {
            ...prev.blurFaces,
            batchStatus: "idle",
            batchActiveTaskId: null,
            batchLiveProgress: null,
            batchErrorMessage: formatError(err),
          },
        }));
        return null;
      }
    },
    [],
  );

  const cancelBlurFacesBatch = useCallback(async () => {
    const tid = activeBlurFacesBatchTaskRef.current;
    if (tid) await cancelBackendTask(tid);
  }, []);

  const updateRemoveBackgroundSession = useCallback(
    (
      patchOrUpdater:
        | Partial<RemoveBackgroundSessionState>
        | ((prev: RemoveBackgroundSessionState) => RemoveBackgroundSessionState),
    ) => {
      if (
        typeof patchOrUpdater !== "function" &&
        patchOrUpdater.activeTaskId === null &&
        activeMattingTaskRef.current
      ) {
        const runningId = activeMattingTaskRef.current;
        activeMattingTaskRef.current = null;
        void cancelBackendTask(runningId);
      }
      setSession((prev) => ({
        ...prev,
        removeBackground:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.removeBackground)
            : { ...prev.removeBackground, ...patchOrUpdater },
      }));
    },
    [],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeMattingProgress((payload) => {
          setSession((prev) => {
            if (prev.removeBackground.activeTaskId !== payload.taskId) {
              return prev;
            }
            return {
              ...prev,
              removeBackground: {
                ...prev.removeBackground,
                liveProgress: payload,
              },
            };
          });
        }),
      "i04-matting-progress",
    );
  }, []);

  const loadRemoveBackgroundFile = useCallback(
    async (rawPath: string, formatError: (err: unknown) => string): Promise<boolean> => {
      const gen = ++mattingSourceGenRef.current;
      setSession((prev) => ({
        ...prev,
        removeBackground: {
          ...prev.removeBackground,
          sourceGeneration: gen,
          loadingSource: true,
          errorMessage: null,
        },
      }));
      try {
        const info = await inspectBeautifierSourceImage(rawPath);
        if (mattingSourceGenRef.current !== gen) {
          return false;
        }
        const runningId = activeMattingTaskRef.current;
        if (runningId) {
          activeMattingTaskRef.current = null;
          void cancelBackendTask(runningId);
        }
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              loadingSource: false,
              sourcePath: info.path,
              sourceAssetId: null,
              sourceFileName: info.fileName,
              sourcePreviewUrl: info.previewDataUrl,
              sourceWidth: info.width,
              sourceHeight: info.height,
              sourceHasAlpha: info.hasAlpha,
              status: "idle",
              activeTaskId: null,
              liveProgress: null,
              result: null,
              errorMessage: null,
              lastSavedMessage: null,
            },
          };
        });
        return true;
      } catch (err) {
        if (mattingSourceGenRef.current !== gen) {
          return false;
        }
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              loadingSource: false,
              errorMessage: formatError(err),
            },
          };
        });
        return false;
      }
    },
    [],
  );

  const pasteRemoveBackgroundClipboard = useCallback(
    async (formatError: (err: unknown) => string, fallbackLabel: string): Promise<boolean> => {
      const gen = ++mattingSourceGenRef.current;
      setSession((prev) => ({
        ...prev,
        removeBackground: {
          ...prev.removeBackground,
          sourceGeneration: gen,
          loadingSource: true,
          errorMessage: null,
        },
      }));
      try {
        const asset = await readClipboardImageAsAsset();
        if (mattingSourceGenRef.current !== gen) {
          return false;
        }
        const runningId = activeMattingTaskRef.current;
        if (runningId) {
          activeMattingTaskRef.current = null;
          void cancelBackendTask(runningId);
        }
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              loadingSource: false,
              sourcePath: null,
              sourceAssetId: asset.assetId,
              sourceFileName: asset.label || fallbackLabel,
              sourcePreviewUrl: asset.dataUrl,
              sourceWidth: asset.width,
              sourceHeight: asset.height,
              sourceHasAlpha: asset.hasAlpha,
              status: "idle",
              activeTaskId: null,
              liveProgress: null,
              result: null,
              errorMessage: null,
              lastSavedMessage: null,
            },
          };
        });
        return true;
      } catch (err) {
        if (mattingSourceGenRef.current !== gen) {
          return false;
        }
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              loadingSource: false,
              errorMessage: formatError(err),
            },
          };
        });
        return false;
      }
    },
    [],
  );

  const clearRemoveBackgroundSession = useCallback(() => {
    const gen = ++mattingSourceGenRef.current;
    const runningId = activeMattingTaskRef.current;
    if (runningId) {
      activeMattingTaskRef.current = null;
      void cancelBackendTask(runningId);
    }
    setSession((prev) => ({
      ...prev,
      removeBackground: {
        ...prev.removeBackground,
        sourceGeneration: gen,
        loadingSource: false,
        sourcePath: null,
        sourceAssetId: null,
        sourceFileName: null,
        sourcePreviewUrl: null,
        sourceWidth: null,
        sourceHeight: null,
        sourceHasAlpha: false,
        status: "idle",
        activeTaskId: null,
        liveProgress: null,
        result: null,
        errorMessage: null,
        lastSavedMessage: null,
      },
    }));
  }, []);

  const startRemoveBackground = useCallback(
    async (
      req: RemoveBackgroundRequest,
      formatError: (err: unknown) => string,
    ): Promise<RemoveBackgroundResult | null> => {
      if (activeMattingTaskRef.current) {
        return null;
      }
      const gen = ++mattingSourceGenRef.current;
      const taskId = `i04-matting-${Date.now()}-${mattingRunSeqRef.current++}`;
      activeMattingTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        removeBackground: {
          ...prev.removeBackground,
          sourceGeneration: gen,
          loadingSource: false,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            phase: "decoding",
            percent: 5,
            detail: "",
          },
          errorMessage: null,
          lastSavedMessage: null,
        },
      }));
      try {
        const res = await removeImageBackground(taskId, req);
        if (activeMattingTaskRef.current !== taskId || mattingSourceGenRef.current !== gen) {
          return null;
        }
        activeMattingTaskRef.current = null;
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              sourcePath: res.sourcePath ?? prev.removeBackground.sourcePath,
              sourceFileName: res.fileName,
              sourcePreviewUrl: res.originalPreviewDataUrl,
              sourceWidth: res.width,
              sourceHeight: res.height,
              sourceHasAlpha: res.sourceHasAlpha,
              status: "done",
              activeTaskId: null,
              liveProgress: null,
              result: res,
              errorMessage: null,
            },
          };
        });
        return res;
      } catch (err) {
        if (activeMattingTaskRef.current !== taskId || mattingSourceGenRef.current !== gen) {
          return null;
        }
        activeMattingTaskRef.current = null;
        const parsed = parseBackendError(err);
        setSession((prev) => {
          if (prev.removeBackground.sourceGeneration !== gen) return prev;
          return {
            ...prev,
            removeBackground: {
              ...prev.removeBackground,
              status:
                parsed.code === "TASK_CANCELLED"
                  ? prev.removeBackground.result
                    ? "done"
                    : "idle"
                  : "error",
              activeTaskId: null,
              liveProgress: null,
              errorMessage: formatError(err),
            },
          };
        });
        return null;
      }
    },
    [],
  );

  const cancelRemoveBackground = useCallback(async () => {
    const tid = activeMattingTaskRef.current;
    if (tid) {
      await cancelBackendTask(tid);
    }
  }, []);

  const updateTextToSpeechSession = useCallback(
    (
      patchOrUpdater:
        | Partial<TextToSpeechSessionState>
        | ((prev: TextToSpeechSessionState) => TextToSpeechSessionState),
    ) => {
      setSession((prev) => ({
        ...prev,
        textToSpeech:
          typeof patchOrUpdater === "function"
            ? patchOrUpdater(prev.textToSpeech)
            : { ...prev.textToSpeech, ...patchOrUpdater },
      }));
    },
    [],
  );

  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeTtsProgress((payload) => {
          setSession((prev) => {
            if (prev.textToSpeech.activeTaskId !== payload.taskId) {
              return prev;
            }
            return {
              ...prev,
              textToSpeech: {
                ...prev.textToSpeech,
                liveProgress: payload,
              },
            };
          });
        }),
      "t06-tts-progress",
    );
  }, []);

  const refreshTtsVoices = useCallback(async (formatError: (err: unknown) => string) => {
    const seq = ++ttsVoiceRefreshSeqRef.current;
    setSession((prev) => ({
      ...prev,
      textToSpeech: {
        ...prev.textToSpeech,
        voicesLoading: true,
      },
    }));
    try {
      const resp = await listTtsVoices();
      if (ttsVoiceRefreshSeqRef.current !== seq) return;
      setSession((prev) => {
        const currentSelected = prev.textToSpeech.selectedVoiceId;
        const stillExists = resp.voices.some((v) => v.id === currentSelected);
        const nextSelected = stillExists
          ? currentSelected
          : (resp.defaultVoiceId ?? resp.voices[0]?.id ?? "");
        return {
          ...prev,
          textToSpeech: {
            ...prev.textToSpeech,
            voices: resp.voices,
            voicesLoaded: true,
            voicesLoading: false,
            hasChineseVoice: resp.hasChineseVoice,
            hasEnglishVoice: resp.hasEnglishVoice,
            selectedVoiceId: nextSelected,
          },
        };
      });
    } catch (err) {
      if (ttsVoiceRefreshSeqRef.current !== seq) return;
      setSession((prev) => ({
        ...prev,
        textToSpeech: {
          ...prev.textToSpeech,
          voicesLoaded: true,
          voicesLoading: false,
          errorMessage: formatError(err),
        },
      }));
    }
  }, []);

  const loadTextToSpeechFile = useCallback(
    async (rawPath: string, formatError: (err: unknown) => string): Promise<boolean> => {
      const loadSeq = ++ttsFileLoadSeqRef.current;
      setSession((prev) => ({
        ...prev,
        textToSpeech: {
          ...prev.textToSpeech,
          loadingFile: true,
        },
      }));
      try {
        // Validate & read candidate file BEFORE bumping sourceGeneration or touching the active task.
        // If reading fails, existing text, audition result, and any running synthesis remain intact.
        const payload = await readLocalTextFile(rawPath);
        if (ttsFileLoadSeqRef.current !== loadSeq) {
          return false;
        }
        const nextGen = ++ttsSourceGenRef.current;
        const runningId = activeTtsTaskRef.current;
        if (runningId) {
          activeTtsTaskRef.current = null;
          void cancelBackendTask(runningId);
        }
        void clearTtsSession();
        setSession((prev) => ({
          ...prev,
          textToSpeech: {
            ...prev.textToSpeech,
            sourceGeneration: nextGen,
            loadingFile: false,
            text: payload.content,
            sourceKind: "txt",
            sourceFilePath: payload.path,
            sourceFileName: payload.fileName,
            sourcePageSummary: null,
            sourceSkippedScannedPages: [],
            sourceTruncated: false,
            status: "idle",
            activeTaskId: null,
            liveProgress: null,
            result: null,
            errorMessage: null,
            lastSavedMessage: null,
            lastSavedPath: null,
          },
        }));
        return true;
      } catch (err) {
        if (ttsFileLoadSeqRef.current !== loadSeq) {
          return false;
        }
        setSession((prev) => ({
          ...prev,
          textToSpeech: {
            ...prev.textToSpeech,
            loadingFile: false,
            errorMessage: formatError(err),
          },
        }));
        return false;
      }
    },
    [],
  );

  const handoffPdfTextToTts = useCallback((payload: TtsPdfHandoffPayload) => {
    ttsFileLoadSeqRef.current += 1;
    const nextGen = ++ttsSourceGenRef.current;
    const runningId = activeTtsTaskRef.current;
    if (runningId) {
      activeTtsTaskRef.current = null;
      void cancelBackendTask(runningId);
    }
    void clearTtsSession();
    const sortedPages = Array.from(new Set(payload.pages)).sort((a, b) => a - b);
    const pageSummary = sortedPages.length > 0 ? formatCompactPages(sortedPages) : null;
    setSession((prev) => ({
      ...prev,
      textToSpeech: {
        ...prev.textToSpeech,
        sourceGeneration: nextGen,
        loadingFile: false,
        text: payload.text,
        sourceKind: "pdf",
        sourceFilePath: payload.path,
        sourceFileName: payload.fileName,
        sourcePageSummary: pageSummary,
        sourceSkippedScannedPages: [...payload.skippedScannedPages],
        sourceTruncated: payload.truncated,
        status: "idle",
        activeTaskId: null,
        liveProgress: null,
        result: null,
        errorMessage: null,
        lastSavedMessage: null,
        lastSavedPath: null,
      },
    }));
    navRef.current?.("T06");
  }, []);

  const startTextToSpeech = useCallback(
    async (
      req: SynthesizeTtsRequest,
      formatError: (err: unknown) => string,
    ): Promise<SynthesizeTtsResult | null> => {
      if (activeTtsTaskRef.current) {
        return null;
      }
      const runGen = ttsSourceGenRef.current;
      const taskId = `t06-tts-${Date.now()}-${ttsRunSeqRef.current++}`;
      activeTtsTaskRef.current = taskId;
      setSession((prev) => ({
        ...prev,
        textToSpeech: {
          ...prev.textToSpeech,
          status: "running",
          activeTaskId: taskId,
          liveProgress: {
            taskId,
            phase: "synthesizing",
            currentSegment: 0,
            totalSegments: 0,
            percent: 2,
            detail: "",
          },
          errorMessage: null,
          lastSavedMessage: null,
        },
      }));
      try {
        const res = await synthesizeTtsSpeech(taskId, req);
        if (activeTtsTaskRef.current !== taskId || ttsSourceGenRef.current !== runGen) {
          return null;
        }
        activeTtsTaskRef.current = null;
        setSession((prev) => {
          if (prev.textToSpeech.sourceGeneration !== runGen) return prev;
          const allowedBitrates =
            res.supportedMp3BitratesKbps?.length > 0
              ? res.supportedMp3BitratesKbps
              : getSupportedTtsMp3Bitrates(res.sampleRate);
          const nextBitrate = allowedBitrates.includes(prev.textToSpeech.mp3BitrateKbps)
            ? prev.textToSpeech.mp3BitrateKbps
            : getDefaultTtsMp3Bitrate(res.sampleRate);
          return {
            ...prev,
            textToSpeech: {
              ...prev.textToSpeech,
              status: "done",
              activeTaskId: null,
              liveProgress: null,
              result: res,
              mp3BitrateKbps: nextBitrate,
            },
          };
        });
        return res;
      } catch (err) {
        if (activeTtsTaskRef.current !== taskId || ttsSourceGenRef.current !== runGen) {
          return null;
        }
        activeTtsTaskRef.current = null;
        const parsed = parseBackendError(err);
        setSession((prev) => {
          if (prev.textToSpeech.sourceGeneration !== runGen) return prev;
          return {
            ...prev,
            textToSpeech: {
              ...prev.textToSpeech,
              status:
                parsed.code === "TASK_CANCELLED"
                  ? prev.textToSpeech.result
                    ? "done"
                    : "idle"
                  : "error",
              activeTaskId: null,
              liveProgress: null,
              errorMessage: formatError(err),
            },
          };
        });
        return null;
      }
    },
    [],
  );

  const cancelTextToSpeech = useCallback(async () => {
    const tid = activeTtsTaskRef.current;
    if (tid) {
      await cancelBackendTask(tid);
    }
  }, []);

  const clearTextToSpeechSession = useCallback(() => {
    ttsFileLoadSeqRef.current += 1;
    const gen = ++ttsSourceGenRef.current;
    const runningId = activeTtsTaskRef.current;
    if (runningId) {
      activeTtsTaskRef.current = null;
      void cancelBackendTask(runningId);
    }
    void clearTtsSession();
    setSession((prev) => ({
      ...prev,
      textToSpeech: {
        ...prev.textToSpeech,
        sourceGeneration: gen,
        loadingFile: false,
        text: "",
        sourceKind: "none",
        sourceFilePath: null,
        sourceFileName: null,
        sourcePageSummary: null,
        sourceSkippedScannedPages: [],
        sourceTruncated: false,
        status: "idle",
        activeTaskId: null,
        liveProgress: null,
        result: null,
        errorMessage: null,
        lastSavedMessage: null,
        lastSavedPath: null,
      },
    }));
  }, []);

  return (
    <SessionStoreContext.Provider
      value={{
        session,
        updateJsonSession,
        updateHashSession,
        updateCodecSession,
        updateUuidSession,
        updateJwtSession,
        updateTimestampSession,
        updateDiffSession,
        updateRegexSession,
        updateUnicodeSession,
        updateCleanLinksSession,
        updateCoordinateSession,
        updateLoremIpsumSession,
        updatePasswordGeneratorSession,
        updateCsvJsonSession,
        updateWordCounterSession,
        updateCaseConverterSession,
        updateScreenCaptureSession,
        updateBlurFacesSession,
        startBlurFacesBatch,
        cancelBlurFacesBatch,
        updateColorPickerSession,
        updateBeautifierSession,
        startBeautifyBatch,
        cancelBeautifyBatch,
        updateImageRedactSession,
        updateImageAnnotateSession,
        updateImageWatermarkSession,
        startImageWatermarkBatch,
        cancelImageWatermarkBatch,
        handoffImageToTool,
        updateBatchRenameSession,
        updateFindDuplicatesSession,
        startDuplicateScan,
        cancelDuplicateScan,
        updateArchiveSession,
        startArchiveExtract,
        startArchiveCreate,
        cancelArchiveTask,
        updateOrganizeDownloadsSession,
        updateImageConvertSession,
        startImageConvertBatch,
        cancelImageConvertBatch,
        updateImageCompressSession,
        startImageCompressBatch,
        cancelImageCompressBatch,
        updateImageResizeSession,
        startImageResizeBatch,
        cancelImageResizeBatch,
        updateImageRotateSession,
        startImageRotateBatch,
        cancelImageRotateBatch,
        updateImageMetadataSession,
        startImageMetadataBatch,
        cancelImageMetadataBatch,
        updateRemoveBackgroundSession,
        loadRemoveBackgroundFile,
        pasteRemoveBackgroundClipboard,
        clearRemoveBackgroundSession,
        startRemoveBackground,
        cancelRemoveBackground,
        updateTextToSpeechSession,
        refreshTtsVoices,
        loadTextToSpeechFile,
        handoffPdfTextToTts,
        startTextToSpeech,
        cancelTextToSpeech,
        clearTextToSpeechSession,
      }}
    >
      {children}
    </SessionStoreContext.Provider>
  );
}

export function useSessionStore(): SessionStoreContextValue {
  const ctx = useContext(SessionStoreContext);
  if (!ctx) {
    throw new Error("useSessionStore must be used inside SessionStoreProvider");
  }
  return ctx;
}

export function useOptionalSessionStore(): SessionStoreContextValue | null {
  return useContext(SessionStoreContext);
}
