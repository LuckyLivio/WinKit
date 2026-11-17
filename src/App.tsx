import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AppRuntimeInfo {
  name: string;
  version: string;
  platform: string;
  arch: string;
}

export function App() {
  const [runtime, setRuntime] = useState<AppRuntimeInfo | null>(null);

  useEffect(() => {
    let active = true;
    invoke<AppRuntimeInfo>("get_runtime_info")
      .then((info) => {
        if (active) {
          setRuntime(info);
        }
      })
      .catch(() => {
        if (active) {
          setRuntime({
            name: "WinKit",
            version: "0.1.0",
            platform: "web-preview",
            arch: "x86_64",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        height: "100%",
        padding: "24px",
        gap: "8px",
      }}
    >
      <h1 style={{ margin: 0, fontSize: "18px", fontWeight: 600 }}>WinKit</h1>
      <p style={{ margin: 0, color: "var(--text-secondary)" }}>
        Windows 11 本地桌面工具箱工程基座已就绪
      </p>
      {runtime && (
        <p className="mono" style={{ margin: 0, fontSize: "12px", color: "var(--text-muted)" }}>
          {runtime.name} v{runtime.version} ({runtime.platform}/{runtime.arch})
        </p>
      )}
    </main>
  );
}
