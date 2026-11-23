import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
import {
  bindDisposableListener,
  cancelBackendTask,
  compressImagesBatch,
  convertImagesBatch,
  createArchive,
  extractArchivesBatch,
  parseBackendError,
  resizeImagesBatch,
  rotateImagesBatch,
  scanDuplicateFolders,
  stripImagesMetadataBatch,
  subscribeArchiveProgress,
  subscribeDuplicateScanProgress,
  subscribeImageBatchProgress,
  type BatchRenameSkippedItem,
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

export type BeautifierAspect = "original" | "1:1" | "16:9";

export interface BeautifierSessionState {
  sourcePath: string | null;
  sourceFileName: string | null;
  previewDataUrl: string | null;
  sourceWidth: number | null;
  sourceHeight: number | null;
  hasAlpha: boolean;
  backgroundColor: string;
  padding: number;
  cornerRadius: number;
  shadowStrength: number;
  aspectRatio: BeautifierAspect;
  lastSavedMessage: string | null;
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
  beautifier: BeautifierSessionState;
  batchRename: BatchRenameSessionState;
  findDuplicates: FindDuplicatesSessionState;
  archive: ArchiveSessionState;
  organizeDownloads: OrganizeDownloadsSessionState;
  imageConvert: ImageConvertSessionState;
  imageCompress: ImageCompressSessionState;
  imageResize: ImageResizeSessionState;
  imageRotate: ImageRotateSessionState;
  imageMetadata: ImageMetadataSessionState;
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
  beautifier: {
    sourcePath: null,
    sourceFileName: null,
    previewDataUrl: null,
    sourceWidth: null,
    sourceHeight: null,
    hasAlpha: false,
    backgroundColor: "#E8ECF2",
    padding: 48,
    cornerRadius: 12,
    shadowStrength: 28,
    aspectRatio: "original",
    lastSavedMessage: null,
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
  updateBeautifierSession: (patch: Partial<BeautifierSessionState>) => void;
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
}

const SessionStoreContext = createContext<SessionStoreContextValue | null>(null);

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  // Stored strictly in memory for the current process session; never persisted to disk.
  const [session, setSession] = useState<SessionWorkspaces>(INITIAL_SESSION_STATE);

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

  const updateBeautifierSession = (patch: Partial<BeautifierSessionState>) => {
    setSession((prev) => ({ ...prev, beautifier: { ...prev.beautifier, ...patch } }));
  };

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
        updateBeautifierSession,
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
