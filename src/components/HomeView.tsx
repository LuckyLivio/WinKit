import { ArrowRight, Star } from "lucide-react";
import { useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import type { RecentToolEntry } from "../lib/preferences";
import { filterTools, type RegisteredTool, type ToolCategory } from "../registry/tools";
import { ToolIcon } from "./ToolIcon";

interface HomeViewProps {
  mode: "all" | "favorites" | "recent";
  tools: RegisteredTool[];
  favorites: string[];
  recentTools: RecentToolEntry[];
  searchQuery: string;
  onOpenTool: (toolId: string) => void;
  onToggleFavorite: (toolId: string) => void;
  onClearSearch: () => void;
}

export function HomeView({
  mode,
  tools,
  favorites,
  recentTools,
  searchQuery,
  onOpenTool,
  onToggleFavorite,
  onClearSearch,
}: HomeViewProps) {
  const { locale, t } = useI18n();
  const [categoryFilter, setCategoryFilter] = useState<"all" | ToolCategory>("all");

  let scopedTools: RegisteredTool[];
  if (mode === "favorites") {
    scopedTools = tools.filter((tool) => favorites.includes(tool.id));
  } else if (mode === "recent") {
    scopedTools = recentTools
      .map((entry) => tools.find((tool) => tool.id === entry.id))
      .filter((tool): tool is RegisteredTool => Boolean(tool));
  } else {
    scopedTools = tools;
  }

  const visibleTools = filterTools(scopedTools, {
    query: searchQuery,
    category: mode === "all" ? categoryFilter : "all",
  });

  const emptyMessage = (() => {
    if (tools.length === 0) return t.home.emptyRegistry;
    if (searchQuery.trim() || (mode === "all" && categoryFilter !== "all")) {
      return t.home.emptySearch;
    }
    if (mode === "favorites") return t.home.emptyFavorites;
    return t.home.emptyRecent;
  })();

  return (
    <div>
      <div className="home-header">
        <div>
          <p className="home-subtitle">{t.home.subtitleAvailable(tools.length)}</p>
        </div>

        {mode === "all" && tools.length > 0 && (
          <div className="segmented" role="group" aria-label={t.categories.all}>
            {(
              [
                "all",
                ...(["developer", "text", "image"] as const).filter((cat) =>
                  tools.some((item) => item.category === cat),
                ),
              ] as const
            ).map((cat) => (
              <button
                key={cat}
                type="button"
                className={`segmented-btn ${categoryFilter === cat ? "is-selected" : ""}`}
                aria-pressed={categoryFilter === cat}
                onClick={() => setCategoryFilter(cat)}
              >
                {t.categories[cat]}
              </button>
            ))}
          </div>
        )}
      </div>

      {visibleTools.length === 0 ? (
        <div className="empty-state">
          <p style={{ margin: 0 }}>{emptyMessage}</p>
          {(searchQuery.trim() !== "" || categoryFilter !== "all") && (
            <div style={{ marginTop: "12px" }}>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setCategoryFilter("all");
                  onClearSearch();
                }}
              >
                {t.home.clearSearch}
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="tool-list" role="list">
          {visibleTools.map((tool) => {
            const favorited = favorites.includes(tool.id);
            return (
              <div key={tool.id} className="tool-row" role="listitem">
                <button type="button" className="tool-row-main" onClick={() => onOpenTool(tool.id)}>
                  <div className="tool-row-icon">
                    <ToolIcon name={tool.icon} size={18} />
                  </div>
                  <div style={{ minWidth: 0 }}>
                    <div className="tool-row-title-line">
                      <span className="badge mono">{tool.id}</span>
                      <span className="tool-row-title">{tool.name[locale]}</span>
                      <span className="badge">{t.categories[tool.category]}</span>
                      <span
                        className={`badge ${tool.implementationStatus === "partial" ? "badge-partial" : "badge-ok"}`}
                      >
                        {tool.implementationStatus === "partial"
                          ? t.home.scopePartial
                          : t.home.scopeFull}
                      </span>
                    </div>
                    <p className="tool-row-summary">{tool.summary[locale]}</p>
                  </div>
                </button>

                <div className="tool-row-actions">
                  <button
                    type="button"
                    className={`btn btn-ghost btn-icon star-btn ${favorited ? "is-favorited" : ""}`}
                    aria-label={favorited ? t.home.favoriteRemove : t.home.favoriteAdd}
                    aria-pressed={favorited}
                    title={favorited ? t.home.favoriteRemove : t.home.favoriteAdd}
                    onClick={() => onToggleFavorite(tool.id)}
                  >
                    <Star
                      size={16}
                      strokeWidth={1.75}
                      fill={favorited ? "currentColor" : "none"}
                      aria-hidden="true"
                    />
                  </button>

                  <button type="button" className="btn" onClick={() => onOpenTool(tool.id)}>
                    <span>{t.home.openTool}</span>
                    <ArrowRight size={14} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="home-footer-note">{t.home.baselineFooter}</div>
    </div>
  );
}
