import { createContext, useContext, useState, type ReactNode } from "react";

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
  textInput: string;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  digestHex: string | null;
  uppercase: boolean;
  expectedHash: string;
  status: "idle" | "running" | "completed" | "cancelled" | "error";
  progressPercent: number | null;
  errorMessage: string | null;
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
    textInput: "",
    filePath: null,
    fileName: null,
    fileSize: null,
    digestHex: null,
    uppercase: false,
    expectedHash: "",
    status: "idle",
    progressPercent: null,
    errorMessage: null,
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
  updateBeautifierSession: (patch: Partial<BeautifierSessionState>) => void;
}

const SessionStoreContext = createContext<SessionStoreContextValue | null>(null);

export function SessionStoreProvider({ children }: { children: ReactNode }) {
  // Stored strictly in memory for the current process session; never persisted to disk.
  const [session, setSession] = useState<SessionWorkspaces>(INITIAL_SESSION_STATE);

  const updateJsonSession = (patch: Partial<JsonSessionState>) => {
    setSession((prev) => ({
      ...prev,
      json: { ...prev.json, ...patch },
    }));
  };

  const updateHashSession = (patch: Partial<HashSessionState>) => {
    setSession((prev) => ({
      ...prev,
      hash: { ...prev.hash, ...patch },
    }));
  };

  const updateBeautifierSession = (patch: Partial<BeautifierSessionState>) => {
    setSession((prev) => ({
      ...prev,
      beautifier: { ...prev.beautifier, ...patch },
    }));
  };

  return (
    <SessionStoreContext.Provider
      value={{ session, updateJsonSession, updateHashSession, updateBeautifierSession }}
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
