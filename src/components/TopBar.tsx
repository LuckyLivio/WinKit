import { Languages, Moon, Search, Sun } from "lucide-react";
import type { RefObject } from "react";
import { useI18n } from "../i18n/I18nContext";

interface TopBarProps {
  title: string;
  toolCode?: string;
  searchQuery: string;
  searchInputRef: RefObject<HTMLInputElement | null>;
  effectiveTheme: "light" | "dark";
  runningTaskCount: number;
  onSearchChange: (q: string) => void;
  onToggleQuickTheme: () => void;
  onToggleLanguage: () => void;
}

export function TopBar({
  title,
  toolCode,
  searchQuery,
  searchInputRef,
  effectiveTheme,
  runningTaskCount,
  onSearchChange,
  onToggleQuickTheme,
  onToggleLanguage,
}: TopBarProps) {
  const { locale, t } = useI18n();

  return (
    <header className="topbar">
      <div className="topbar-title-group">
        {toolCode && <span className="topbar-code-pill mono">{toolCode}</span>}
        <h1 className="topbar-title">{title}</h1>
      </div>

      <div className="topbar-actions">
        {runningTaskCount > 0 && (
          <div className="task-pill" role="status" aria-live="polite">
            <span className="task-dot" aria-hidden="true" />
            <span>{t.topbar.runningTasksCount(runningTaskCount)}</span>
          </div>
        )}

        <div className="search-box">
          <Search size={14} strokeWidth={1.75} className="search-box-icon" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            className="search-input"
            value={searchQuery}
            placeholder={t.topbar.searchPlaceholder}
            aria-label={t.topbar.searchPlaceholder}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && searchQuery) {
                e.preventDefault();
                onSearchChange("");
              }
            }}
          />
          <kbd className="search-kbd mono">{t.topbar.searchShortcutHint}</kbd>
        </div>

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t.topbar.languageToggleLabel}
          title={`${t.topbar.languageToggleLabel} (${locale === "zh-CN" ? "English" : "简体中文"})`}
          onClick={onToggleLanguage}
        >
          <Languages size={16} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-icon"
          aria-label={t.topbar.themeToggleLabel}
          title={t.topbar.themeToggleLabel}
          onClick={onToggleQuickTheme}
        >
          {effectiveTheme === "dark" ? (
            <Sun size={16} strokeWidth={1.75} aria-hidden="true" />
          ) : (
            <Moon size={16} strokeWidth={1.75} aria-hidden="true" />
          )}
        </button>
      </div>
    </header>
  );
}
