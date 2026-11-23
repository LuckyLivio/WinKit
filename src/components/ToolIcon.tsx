import {
  ArrowLeftRight,
  Binary,
  Braces,
  CaseSensitive,
  Clock,
  Compass,
  FileArchive,
  FilePenLine,
  FileText,
  Fingerprint,
  FolderInput,
  FolderSearch,
  Frame,
  GitCompareArrows,
  KeyRound,
  Link2,
  LockKeyhole,
  Minimize2,
  QrCode,
  Regex,
  RotateCw,
  Scaling,
  ScanText,
  ShieldCheck,
  Table2,
  TextQuote,
} from "lucide-react";
import type { ToolIconName } from "../registry/tools";

export function ToolIcon({ name, size = 18 }: { name: ToolIconName; size?: number }) {
  switch (name) {
    case "qr-code":
      return <QrCode size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "file-pen-line":
      return <FilePenLine size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "folder-search":
      return <FolderSearch size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "file-archive":
      return <FileArchive size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "folder-input":
      return <FolderInput size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "braces":
      return <Braces size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "binary":
      return <Binary size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "shield-check":
      return <ShieldCheck size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "fingerprint":
      return <Fingerprint size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "key-round":
      return <KeyRound size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "clock":
      return <Clock size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "git-compare":
      return <GitCompareArrows size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "regex":
      return <Regex size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "link":
      return <Link2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "compass":
      return <Compass size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "scan-text":
      return <ScanText size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "text-quote":
      return <TextQuote size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "lock-keyhole":
      return <LockKeyhole size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "file-text":
      return <FileText size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "case-sensitive":
      return <CaseSensitive size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "frame":
      return <Frame size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-convert":
      return <ArrowLeftRight size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-compress":
      return <Minimize2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-resize":
      return <Scaling size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-rotate":
      return <RotateCw size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "table-2":
      return <Table2 size={size} strokeWidth={1.75} aria-hidden="true" />;
  }
}
