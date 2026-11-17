import type { Locale, ThemePreference } from "../i18n/messages";

export const PREFERENCES_STORAGE_KEY = "winkit.preferences.v1";
const MAX_RECENT_TOOLS = 12;

export interface RecentToolEntry {
  id: string;
  visitedAt: number;
}

export interface UserPreferences {
  theme: ThemePreference;
  locale: Locale;
  favorites: string[];
  recentTools: RecentToolEntry[];
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  theme: "light",
  locale: "zh-CN",
  favorites: [],
  recentTools: [],
};

function isValidTheme(val: unknown): val is ThemePreference {
  return val === "light" || val === "dark" || val === "system";
}

function isValidLocale(val: unknown): val is Locale {
  return val === "zh-CN" || val === "en-US";
}

export function loadPreferences(): UserPreferences {
  try {
    const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_PREFERENCES };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return { ...DEFAULT_PREFERENCES };
    }
    const obj = parsed as Record<string, unknown>;
    const favorites = Array.isArray(obj.favorites)
      ? Array.from(
          new Set(
            obj.favorites.filter(
              (item): item is string => typeof item === "string" && item.length > 0,
            ),
          ),
        )
      : [];

    const recentTools: RecentToolEntry[] = Array.isArray(obj.recentTools)
      ? obj.recentTools
          .filter((item): item is RecentToolEntry => {
            if (!item || typeof item !== "object") return false;
            const rec = item as Record<string, unknown>;
            return typeof rec.id === "string" && typeof rec.visitedAt === "number";
          })
          .slice(0, MAX_RECENT_TOOLS)
      : [];

    return {
      theme: isValidTheme(obj.theme) ? obj.theme : DEFAULT_PREFERENCES.theme,
      locale: isValidLocale(obj.locale) ? obj.locale : DEFAULT_PREFERENCES.locale,
      favorites,
      recentTools,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function savePreferences(prefs: UserPreferences): void {
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Ignore storage quota errors cleanly without crashing UI
  }
}

export function toggleFavoriteId(favorites: string[], id: string): string[] {
  if (favorites.includes(id)) {
    return favorites.filter((f) => f !== id);
  }
  return [...favorites, id];
}

export function recordRecentToolVisit(
  recentTools: RecentToolEntry[],
  id: string,
  now = Date.now(),
): RecentToolEntry[] {
  const filtered = recentTools.filter((entry) => entry.id !== id);
  return [{ id, visitedAt: now }, ...filtered].slice(0, MAX_RECENT_TOOLS);
}

export function resolveEffectiveTheme(theme: ThemePreference): "light" | "dark" {
  if (theme === "light" || theme === "dark") {
    return theme;
  }
  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return "light";
}

export function applyDocumentPreferences(theme: ThemePreference, locale: Locale): "light" | "dark" {
  const effective = resolveEffectiveTheme(theme);
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("data-theme", effective);
    document.documentElement.setAttribute("lang", locale);
  }
  return effective;
}
