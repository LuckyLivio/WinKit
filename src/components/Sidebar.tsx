import { Clock, LayoutGrid, Settings, Star } from "lucide-react";
import { useI18n } from "../i18n/I18nContext";
import type { RegisteredTool } from "../registry/tools";
import { ToolIcon } from "./ToolIcon";

export type ActiveRoute =
  | { kind: "home"; filter: "all" | "favorites" | "recent" }
  | { kind: "settings" }
  | { kind: "tool"; toolId: string };

interface SidebarProps {
  route: ActiveRoute;
  tools: RegisteredTool[];
  favoritesCount: number;
  recentCount: number;
  onNavigate: (next: ActiveRoute) => void;
}

export function Sidebar({ route, tools, favoritesCount, recentCount, onNavigate }: SidebarProps) {
  const { locale, t } = useI18n();

  const isHomeFilter = (f: "all" | "favorites" | "recent") =>
    route.kind === "home" && route.filter === f;

  return (
    <aside className="sidebar" aria-label={t.appName}>
      <div>
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <span className="sidebar-brand-name">{t.appName}</span>
        </div>

        <nav className="sidebar-group" aria-label={t.nav.home}>
          <button
            type="button"
            className={`nav-item ${isHomeFilter("all") ? "is-active" : ""}`}
            aria-current={isHomeFilter("all") ? "page" : undefined}
            onClick={() => onNavigate({ kind: "home", filter: "all" })}
          >
            <span className="nav-item-main">
              <LayoutGrid size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="nav-item-text">{t.nav.home}</span>
            </span>
            <span className="nav-item-code mono">{tools.length}</span>
          </button>

          <button
            type="button"
            className={`nav-item ${isHomeFilter("favorites") ? "is-active" : ""}`}
            aria-current={isHomeFilter("favorites") ? "page" : undefined}
            onClick={() => onNavigate({ kind: "home", filter: "favorites" })}
          >
            <span className="nav-item-main">
              <Star size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="nav-item-text">{t.nav.favorites}</span>
            </span>
            {favoritesCount > 0 && <span className="nav-item-code mono">{favoritesCount}</span>}
          </button>

          <button
            type="button"
            className={`nav-item ${isHomeFilter("recent") ? "is-active" : ""}`}
            aria-current={isHomeFilter("recent") ? "page" : undefined}
            onClick={() => onNavigate({ kind: "home", filter: "recent" })}
          >
            <span className="nav-item-main">
              <Clock size={16} strokeWidth={1.75} aria-hidden="true" />
              <span className="nav-item-text">{t.nav.recent}</span>
            </span>
            {recentCount > 0 && <span className="nav-item-code mono">{recentCount}</span>}
          </button>
        </nav>

        {tools.length > 0 && (
          <>
            <div className="sidebar-section-label">{t.nav.availableToolsHeading}</div>
            <nav className="sidebar-group" aria-label={t.nav.availableToolsHeading}>
              {tools.map((tool) => {
                const active = route.kind === "tool" && route.toolId === tool.id;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    className={`nav-item ${active ? "is-active" : ""}`}
                    aria-current={active ? "page" : undefined}
                    onClick={() => onNavigate({ kind: "tool", toolId: tool.id })}
                  >
                    <span className="nav-item-main">
                      <ToolIcon name={tool.icon} size={16} />
                      <span className="nav-item-text">{tool.name[locale]}</span>
                    </span>
                    <span className="nav-item-code mono">{tool.id}</span>
                  </button>
                );
              })}
            </nav>
          </>
        )}
      </div>

      <div className="sidebar-group">
        <button
          type="button"
          className={`nav-item ${route.kind === "settings" ? "is-active" : ""}`}
          aria-current={route.kind === "settings" ? "page" : undefined}
          onClick={() => onNavigate({ kind: "settings" })}
        >
          <span className="nav-item-main">
            <Settings size={16} strokeWidth={1.75} aria-hidden="true" />
            <span className="nav-item-text">{t.nav.settings}</span>
          </span>
        </button>
      </div>
    </aside>
  );
}
