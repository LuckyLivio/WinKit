import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HomeView } from "./components/HomeView";
import { SettingsView } from "./components/SettingsView";
import { ShutdownDialog, type ShutdownDialogState } from "./components/ShutdownDialog";
import { Sidebar, type ActiveRoute } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { I18nContext } from "./i18n/I18nContext";
import { MESSAGES, type Locale, type Messages, type ThemePreference } from "./i18n/messages";
import {
  DEFAULT_PREFERENCES,
  applyDocumentPreferences,
  loadPreferences,
  recordRecentToolVisit,
  savePreferences,
  toggleFavoriteId,
  type UserPreferences,
} from "./lib/preferences";
import { SessionStoreProvider } from "./lib/sessionStore";
import {
  enterFrontendShutdownGate,
  resetFrontendShutdownGate,
  terminateAllFrontendWorkers,
} from "./lib/shutdownGate";
import {
  abortGracefulShutdown,
  beginGracefulShutdown,
  bindDisposableListener,
  destroyCurrentWindow,
  fetchRuntimeInfo,
  formatLocalizedError,
  requestWindowClose,
  subscribeNativeCloseRequest,
  subscribeTaskProgress,
  type AppRuntimeInfo,
} from "./lib/tauriBridge";
import { REGISTERED_TOOLS, type RegisteredTool } from "./registry/tools";
import "./styles/layout.css";

interface AppProps {
  toolsOverride?: RegisteredTool[];
}

export function App({ toolsOverride }: AppProps = {}) {
  const tools = toolsOverride ?? REGISTERED_TOOLS;
  const [prefs, setPrefs] = useState<UserPreferences>(() => loadPreferences());
  const [effectiveTheme, setEffectiveTheme] = useState<"light" | "dark">(() =>
    applyDocumentPreferences(prefs.theme, prefs.locale),
  );
  const [route, setRoute] = useState<ActiveRoute>({ kind: "home", filter: "all" });
  const [searchQuery, setSearchQuery] = useState("");
  const [runtime, setRuntime] = useState<AppRuntimeInfo | null>(null);
  const [activeTaskIds, setActiveTaskIds] = useState<string[]>([]);
  const [shutdownState, setShutdownState] = useState<ShutdownDialogState>({ phase: "idle" });

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const shutdownPhaseRef = useRef<ShutdownDialogState["phase"]>("idle");

  const t = MESSAGES[prefs.locale];
  const tRef = useRef<Messages>(t);
  tRef.current = t;

  const setCoordinatedShutdown = useCallback((next: ShutdownDialogState) => {
    shutdownPhaseRef.current = next.phase;
    setShutdownState(next);
  }, []);

  // Apply theme & locale to document root and listen to OS theme changes when set to "system"
  useEffect(() => {
    const nextEffective = applyDocumentPreferences(prefs.theme, prefs.locale);
    setEffectiveTheme(nextEffective);
    savePreferences(prefs);

    if (prefs.theme !== "system" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      setEffectiveTheme(applyDocumentPreferences("system", prefs.locale));
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [prefs]);

  // Fetch runtime info once
  useEffect(() => {
    let mounted = true;
    fetchRuntimeInfo()
      .then((info) => {
        if (mounted) setRuntime(info);
      })
      .catch((err) => {
        console.error("[WinKit] Failed to fetch runtime info:", err);
      });
    return () => {
      mounted = false;
    };
  }, []);

  // Track active backend tasks via real Tauri progress events (StrictMode-safe unlisten)
  useEffect(() => {
    return bindDisposableListener(
      () =>
        subscribeTaskProgress((payload) => {
          setActiveTaskIds((prev) => {
            if (payload.state === "running") {
              return prev.includes(payload.taskId) ? prev : [...prev, payload.taskId];
            }
            return prev.filter((id) => id !== payload.taskId);
          });
        }),
      "winkit://task-progress",
    );
  }, []);

  // Coordinate native window close requests (`×` / `Alt+F4`) against authoritative backend task admission
  useEffect(() => {
    return () => {
      resetFrontendShutdownGate();
      terminateAllFrontendWorkers();
    };
  }, []);

  const handleNativeCloseRequest = useCallback(async () => {
    if (shutdownPhaseRef.current !== "idle") {
      return;
    }
    shutdownPhaseRef.current = "closing";
    enterFrontendShutdownGate();

    let decision;
    try {
      decision = await requestWindowClose();
    } catch (err) {
      resetFrontendShutdownGate();
      await abortGracefulShutdown().catch(() => {});
      setCoordinatedShutdown({
        phase: "error",
        message: formatLocalizedError(err, tRef.current),
      });
      return;
    }

    const { immediateCloseAllowed, snapshot } = decision;
    // Reconcile frontend indicator with authoritative backend task list
    setActiveTaskIds(snapshot.tasks.map((item) => item.taskId));

    if (immediateCloseAllowed) {
      terminateAllFrontendWorkers();
      try {
        await destroyCurrentWindow();
      } catch (err) {
        resetFrontendShutdownGate();
        await abortGracefulShutdown().catch(() => {});
        setCoordinatedShutdown({
          phase: "error",
          message: formatLocalizedError(err, tRef.current),
        });
      }
      return;
    }

    // Active tasks exist and user has not confirmed exit yet: restore frontend admission while confirming
    resetFrontendShutdownGate();
    setCoordinatedShutdown({
      phase: "confirming",
      activeCount: Math.max(1, snapshot.activeCount),
      writeFinishingCount: snapshot.writeFinishingCount,
    });
  }, [setCoordinatedShutdown]);

  useEffect(() => {
    return bindDisposableListener(
      () => subscribeNativeCloseRequest(handleNativeCloseRequest),
      "tauri://close-requested",
    );
  }, [handleNativeCloseRequest]);

  const handleStayInApp = useCallback(() => {
    if (shutdownPhaseRef.current === "draining" || shutdownPhaseRef.current === "closing") {
      return;
    }
    const wasError = shutdownPhaseRef.current === "error";
    resetFrontendShutdownGate();
    setCoordinatedShutdown({ phase: "idle" });
    if (wasError) {
      void abortGracefulShutdown().catch((err) => {
        console.error("[WinKit] Failed to reset shutdown flag:", err);
      });
    }
  }, [setCoordinatedShutdown]);

  const handleConfirmQuit = useCallback(async () => {
    if (shutdownPhaseRef.current === "draining" || shutdownPhaseRef.current === "closing") {
      return;
    }
    enterFrontendShutdownGate();
    terminateAllFrontendWorkers();
    setCoordinatedShutdown({ phase: "draining" });

    try {
      const drain = await beginGracefulShutdown(8000);
      if (!drain.readyToClose) {
        resetFrontendShutdownGate();
        setActiveTaskIds(drain.remainingTasks.map((item) => item.taskId));
        const summary = drain.remainingTasks
          .map((item) => `${item.toolId}:${item.taskId}`)
          .join(", ");
        setCoordinatedShutdown({
          phase: "error",
          message: tRef.current.closeGuard.timeoutBody(summary || "unknown"),
        });
        return;
      }

      setActiveTaskIds([]);
      shutdownPhaseRef.current = "closing";
      try {
        await destroyCurrentWindow();
      } catch (destroyErr) {
        resetFrontendShutdownGate();
        await abortGracefulShutdown().catch(() => {});
        setCoordinatedShutdown({
          phase: "error",
          message: formatLocalizedError(destroyErr, tRef.current),
        });
      }
    } catch (err) {
      resetFrontendShutdownGate();
      await abortGracefulShutdown().catch(() => {});
      setCoordinatedShutdown({
        phase: "error",
        message: formatLocalizedError(err, tRef.current),
      });
    }
  }, [setCoordinatedShutdown]);

  // Global Ctrl+K shortcut to focus tool search (disabled while shutdown dialog is open)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (shutdownPhaseRef.current !== "idle") {
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (route.kind !== "home") {
          setRoute({ kind: "home", filter: "all" });
        }
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [route.kind]);

  const setLocale = useCallback((locale: Locale) => {
    setPrefs((prev) => ({ ...prev, locale }));
  }, []);

  const setTheme = useCallback((theme: ThemePreference) => {
    setPrefs((prev) => ({ ...prev, theme }));
  }, []);

  const openTool = useCallback((toolId: string) => {
    setRoute({ kind: "tool", toolId });
    setPrefs((prev) => ({
      ...prev,
      recentTools: recordRecentToolVisit(prev.recentTools, toolId),
    }));
  }, []);

  const handleNavigate = useCallback(
    (next: ActiveRoute) => {
      if (next.kind === "tool") {
        openTool(next.toolId);
      } else {
        setRoute(next);
      }
    },
    [openTool],
  );

  const handleSearchChange = useCallback(
    (query: string) => {
      setSearchQuery(query);
      if (query.trim() !== "" && route.kind !== "home") {
        setRoute({ kind: "home", filter: "all" });
      }
    },
    [route.kind],
  );

  const handleToggleFavorite = useCallback((toolId: string) => {
    setPrefs((prev) => ({
      ...prev,
      favorites: toggleFavoriteId(prev.favorites, toolId),
    }));
  }, []);

  const i18nValue = useMemo(
    () => ({
      locale: prefs.locale,
      t,
      setLocale,
    }),
    [prefs.locale, t, setLocale],
  );

  const activeTool =
    route.kind === "tool" ? tools.find((item) => item.id === route.toolId) : undefined;

  const topbarTitle = (() => {
    if (activeTool) return activeTool.name[prefs.locale];
    if (route.kind === "settings") return t.settings.title;
    if (route.kind === "home" && route.filter === "favorites") return t.home.titleFavorites;
    if (route.kind === "home" && route.filter === "recent") return t.home.titleRecent;
    return t.home.titleAll;
  })();

  const validFavoritesCount = tools.filter((tool) => prefs.favorites.includes(tool.id)).length;
  const validRecentCount = prefs.recentTools.filter((r) =>
    tools.some((tool) => tool.id === r.id),
  ).length;

  return (
    <I18nContext.Provider value={i18nValue}>
      <SessionStoreProvider>
        <div className="app-shell">
          <Sidebar
            route={route}
            tools={tools}
            favoritesCount={validFavoritesCount}
            recentCount={validRecentCount}
            onNavigate={handleNavigate}
          />

          <div className="main-column">
            <TopBar
              title={topbarTitle}
              toolCode={activeTool?.id}
              searchQuery={searchQuery}
              searchInputRef={searchInputRef}
              effectiveTheme={effectiveTheme}
              runningTaskCount={activeTaskIds.length}
              onSearchChange={handleSearchChange}
              onToggleQuickTheme={() => setTheme(effectiveTheme === "dark" ? "light" : "dark")}
              onToggleLanguage={() => setLocale(prefs.locale === "zh-CN" ? "en-US" : "zh-CN")}
            />

            <main className="workspace-scroll">
              {route.kind === "settings" ? (
                <SettingsView
                  theme={prefs.theme}
                  locale={prefs.locale}
                  recentCount={validRecentCount}
                  runtime={runtime}
                  onChangeTheme={setTheme}
                  onChangeLocale={setLocale}
                  onClearRecent={() => setPrefs((prev) => ({ ...prev, recentTools: [] }))}
                  onResetPreferences={() =>
                    setPrefs((prev) => ({
                      ...DEFAULT_PREFERENCES,
                      favorites: prev.favorites,
                      recentTools: prev.recentTools,
                    }))
                  }
                />
              ) : activeTool ? (
                <activeTool.component />
              ) : (
                <HomeView
                  mode={route.kind === "home" ? route.filter : "all"}
                  tools={tools}
                  favorites={prefs.favorites}
                  recentTools={prefs.recentTools}
                  searchQuery={searchQuery}
                  onOpenTool={openTool}
                  onToggleFavorite={handleToggleFavorite}
                  onClearSearch={() => setSearchQuery("")}
                />
              )}
            </main>
          </div>
        </div>

        <ShutdownDialog
          state={shutdownState}
          liveActiveCount={activeTaskIds.length}
          onStay={handleStayInApp}
          onConfirmQuit={() => void handleConfirmQuit()}
        />
      </SessionStoreProvider>
    </I18nContext.Provider>
  );
}
