import {
  ArrowLeftRight,
  AudioLines,
  AudioWaveform,
  Binary,
  Braces,
  Camera,
  Captions,
  CaseSensitive,
  Clock,
  Combine,
  Compass,
  Crop,
  Download,
  EyeOff,
  FileArchive,
  FileAudio,
  FileImage,
  FileMinus2,
  FileOutput,
  FilePenLine,
  FileSearch,
  FileText,
  Film,
  Fingerprint,
  FolderInput,
  FolderSearch,
  Frame,
  Gauge,
  GitCompareArrows,
  Images,
  Info,
  KeyRound,
  LayoutGrid,
  Link2,
  Lock,
  LockKeyhole,
  LockOpen,
  Mic,
  Minimize2,
  Pencil,
  PenTool,
  Pipette,
  QrCode,
  Regex,
  RotateCw,
  ScanFace,
  ScanLine,
  Scaling,
  ScanText,
  Scissors,
  ShieldCheck,
  ShieldOff,
  SlidersHorizontal,
  Stamp,
  Table2,
  TextQuote,
  Video,
  Volume2,
  VolumeX,
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
    case "capture-text":
      return <ScanLine size={size} strokeWidth={1.75} aria-hidden="true" />;
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
    case "screenshot":
      return <Camera size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "blur-faces":
      return <ScanFace size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-convert":
      return <ArrowLeftRight size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-compress":
      return <Minimize2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-resize":
      return <Scaling size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-rotate":
      return <RotateCw size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-metadata":
      return <ShieldOff size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "color-picker":
      return <Pipette size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-redact":
      return <EyeOff size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-annotate":
      return <Pencil size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "image-watermark":
      return <Stamp size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "table-2":
      return <Table2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "media-info":
      return <Info size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-trim":
      return <Scissors size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-mute":
      return <VolumeX size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "audio-extract":
      return <FileAudio size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-frames":
      return <Images size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-gif":
      return <Film size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-convert":
      return <ArrowLeftRight size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-compress":
      return <Minimize2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-resize":
      return <Scaling size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-crop":
      return <Crop size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-speed":
      return <Gauge size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-merge":
      return <Combine size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "audio-trim":
      return <AudioWaveform size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "audio-record":
      return <Mic size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "audio-convert":
      return <AudioLines size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "audio-cleanup":
      return <SlidersHorizontal size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-replace-audio":
      return <Volume2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-subtitles":
      return <Captions size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "screen-record":
      return <Video size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "video-download":
      return <Download size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-merge":
      return <Combine size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-split":
      return <Scissors size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-organize":
      return <LayoutGrid size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-delete":
      return <FileMinus2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-extract":
      return <FileOutput size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-images-to-pdf":
      return <FileImage size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-to-images":
      return <Images size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-sign":
      return <PenTool size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-crop":
      return <Crop size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-encrypt":
      return <Lock size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-decrypt":
      return <LockOpen size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-compress":
      return <Minimize2 size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-markdown":
      return <FileText size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "pdf-searchable":
      return <FileSearch size={size} strokeWidth={1.75} aria-hidden="true" />;
  }
}
