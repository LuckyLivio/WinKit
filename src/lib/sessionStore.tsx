import { createContext, useContext, useState, type ReactNode } from "react";
import type {
  Base64WrapWidth,
  CodecFormat,
  CodecOperation,
  CodecTransformResponse,
} from "../tools/codec/codecEngine";
import type { AlgorithmDigestEntry, HashAlgorithm } from "../tools/hash-generator/hashUtils";
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
import type { ConversionDirection, CsvDelimiter } from "../tools/csv-json/csvJsonEngine";

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
  textInput: string;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  digests: AlgorithmDigestEntry[] | null;
  needsRecompute: boolean;
  uppercase: boolean;
  expectedHash: string;
  status: "idle" | "running" | "completed" | "cancelled" | "error";
  progressPercent: number | null;
  errorMessage: string | null;
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
  isStale: boolean;
}

export interface CsvJsonSessionState {
  inputText: string;
  direction: ConversionDirection;
  delimiter: CsvDelimiter;
  firstRowHeaders: boolean;
  detectTypes: boolean;
  formulaProtection: boolean;
  outputText: string;
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
  loremIpsum: LoremIpsumSessionState;
  passwordGenerator: PasswordGeneratorSessionState;
  csvJson: CsvJsonSessionState;
  wordCounter: WordCounterSessionState;
  caseConverter: CaseConverterSessionState;
  beautifier: BeautifierSessionState;
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
    textInput: "",
    filePath: null,
    fileName: null,
    fileSize: null,
    digests: null,
    needsRecompute: false,
    uppercase: false,
    expectedHash: "",
    status: "idle",
    progressPercent: null,
    errorMessage: null,
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
    isStale: false,
  },
  csvJson: {
    inputText: "",
    direction: "csv_to_json",
    delimiter: "auto",
    firstRowHeaders: true,
    detectTypes: false,
    formulaProtection: false,
    outputText: "",
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
};

interface SessionStoreContextValue {
  session: SessionWorkspaces;
  updateJsonSession: (patch: Partial<JsonSessionState>) => void;
  updateHashSession: (patch: Partial<HashSessionState>) => void;
  updateCodecSession: (patch: Partial<CodecSessionState>) => void;
  updateUuidSession: (patch: Partial<UuidSessionState>) => void;
  updateJwtSession: (patch: Partial<JwtSessionState>) => void;
  updateTimestampSession: (patch: Partial<TimestampSessionState>) => void;
  updateDiffSession: (patch: Partial<DiffSessionState>) => void;
  updateRegexSession: (patch: Partial<RegexSessionState>) => void;
  updateUnicodeSession: (patch: Partial<UnicodeSessionState>) => void;
  updateCleanLinksSession: (patch: Partial<CleanLinksSessionState>) => void;
  updateLoremIpsumSession: (patch: Partial<LoremIpsumSessionState>) => void;
  updatePasswordGeneratorSession: (patch: Partial<PasswordGeneratorSessionState>) => void;
  updateCsvJsonSession: (patch: Partial<CsvJsonSessionState>) => void;
  updateWordCounterSession: (patch: Partial<WordCounterSessionState>) => void;
  updateCaseConverterSession: (patch: Partial<CaseConverterSessionState>) => void;
  updateBeautifierSession: (patch: Partial<BeautifierSessionState>) => void;
}

const SessionStoreContext = createContext<SessionStoreContextValue | null>(null);

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  // Stored strictly in memory for the current process session; never persisted to disk.
  const [session, setSession] = useState<SessionWorkspaces>(INITIAL_SESSION_STATE);

  const updateJsonSession = (patch: Partial<JsonSessionState>) => {
    setSession((prev) => ({ ...prev, json: { ...prev.json, ...patch } }));
  };

  const updateHashSession = (patch: Partial<HashSessionState>) => {
    setSession((prev) => ({ ...prev, hash: { ...prev.hash, ...patch } }));
  };

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
        updateLoremIpsumSession,
        updatePasswordGeneratorSession,
        updateCsvJsonSession,
        updateWordCounterSession,
        updateCaseConverterSession,
        updateBeautifierSession,
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
