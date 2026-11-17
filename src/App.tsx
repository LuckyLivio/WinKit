import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { HomeView } from "./components/HomeView";
import { SettingsView } from "./components/SettingsView";
import { Sidebar, type ActiveRoute } from "./components/Sidebar";
import { TopBar } from "./components/TopBar";
import { I18nContext } from "./i18n/I18nContext";
import { MESSAGES, type Locale, type ThemePreference } from "./i18n/messages";
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
  cancelBackendTask,
  fetchRuntimeInfo,
  forceDestroyWindow,
  subscribeTaskProgress,
  subscribeWindowCloseGuard,
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
  const [pendingCloseTaskCount, setPendingCloseTaskCount] = useState<number | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const activeTaskIdsRef = useRef<string[]>([]);
  activeTaskIdsRef.current = activeTaskIds;

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
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  // Track active backend tasks via real Tauri progress events
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    subscribeTaskProgress((payload) => {
      setActiveTaskIds((prev) => {
        if (payload.state === "running") {
          return prev.includes(payload.taskId) ? prev : [...prev, payload.taskId];
        }
        return prev.filter((id) => id !== payload.taskId);
      });
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  // Intercept window close when tasks are actively running
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    subscribeWindowCloseGuard(
      () => activeTaskIdsRef.current.length,
      (count) => setPendingCloseTaskCount(count),
    )
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unlisten?.();
    };
  }, []);

  // Global Ctrl+K shortcut to focus tool search
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
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

  const t = MESSAGES[prefs.locale];
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

        <ConfirmDialog
          open={pendingCloseTaskCount !== null}
          title={t.closeGuard.title}
          body={t.closeGuard.body(pendingCloseTaskCount ?? 1)}
          confirmLabel={t.closeGuard.quitAnywayButton}
          cancelLabel={t.closeGuard.stayButton}
          danger
          onCancel={() => setPendingCloseTaskCount(null)}
          onConfirm={async () => {
            const ids = [...activeTaskIdsRef.current];
            setPendingCloseTaskCount(null);
            await Promise.allSettled(ids.map((id) => cancelBackendTask(id)));
            await forceDestroyWindow();
          }}
        />
      </SessionStoreProvider>
    </I18nContext.Provider>
  );
}
