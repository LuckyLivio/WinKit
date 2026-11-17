import { Braces, Frame, ShieldCheck } from "lucide-react";
import type { ToolIconName } from "../registry/tools";

export function ToolIcon({ name, size = 18 }: { name: ToolIconName; size?: number }) {
  switch (name) {
    case "braces":
      return <Braces size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "shield-check":
      return <ShieldCheck size={size} strokeWidth={1.75} aria-hidden="true" />;
    case "frame":
      return <Frame size={size} strokeWidth={1.75} aria-hidden="true" />;
  }
}
