import { lazy, Suspense, useState } from "react";
import { useI18n } from "../../i18n/I18nContext";
import { QrGenerateView } from "./QrGenerateView";

const QrReadView = lazy(async () => ({ default: (await import("./QrReadView")).QrReadView }));

export function QrWorkspace() {
  const { locale } = useI18n();
  const zh = locale === "zh-CN";
  const [mode, setMode] = useState<"generate" | "read">("generate");

  return (
    <div className="tool-workspace">
      <div className="tool-toolbar">
        <div className="segmented" role="group" aria-label={zh ? "二维码工具" : "QR code tools"}>
          {(["generate", "read"] as const).map((view) => (
            <button
              type="button"
              key={view}
              className={`segmented-btn ${mode === view ? "is-selected" : ""}`}
              aria-pressed={mode === view}
              onClick={() => setMode(view)}
            >
              {view === "generate" ? (zh ? "生成" : "Generate") : zh ? "读取" : "Read"}
            </button>
          ))}
        </div>
      </div>
      <div hidden={mode !== "generate"}>
        <QrGenerateView />
      </div>
      {mode === "read" && (
        <Suspense fallback={<p role="status">{zh ? "正在打开读取视图…" : "Opening reader…"}</p>}>
          <QrReadView />
        </Suspense>
      )}
    </div>
  );
}
