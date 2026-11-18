import {
  Binary,
  Braces,
  CaseSensitive,
  Clock,
  FileText,
  Fingerprint,
  Frame,
  GitCompareArrows,
  KeyRound,
  Link2,
  Regex,
  ScanText,
  ShieldCheck,
  TextQuote,
} from "lucide-react";
import type { ToolIconName } from "../registry/tools";

export function ToolIcon({ name, size = 18 }: { name: ToolIconName; size?: number }) {
  switch (name) {
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
    case "scan-text":
      return <ScanText size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "text-quote":
      return <TextQuote size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "file-text":
      return <FileText size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "case-sensitive":
      return <CaseSensitive size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "frame":
      return <Frame size={size} strokeWidth={1.75} aria-hidden="true" />;
  }
}
