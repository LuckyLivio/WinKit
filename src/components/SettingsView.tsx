import { useState } from "react";
import { useI18n } from "../i18n/I18nContext";
import type { Locale, ThemePreference } from "../i18n/messages";
import type { AppRuntimeInfo } from "../lib/tauriBridge";
import { MediaToolsSetupPanel } from "./MediaToolsSetupPanel";
import { YtdlpSetupPanel } from "./YtdlpSetupPanel";

interface SettingsViewProps {
  theme: ThemePreference;
  locale: Locale;
  recentCount: number;
  runtime: AppRuntimeInfo | null;
  onChangeTheme: (theme: ThemePreference) => void;
  onChangeLocale: (locale: Locale) => void;
  onClearRecent: () => void;
  onResetPreferences: () => void;
}

export function SettingsView({
  theme,
  locale,
  recentCount,
  runtime,
  onChangeTheme,
  onChangeLocale,
  onClearRecent,
  onResetPreferences,
}: SettingsViewProps) {
  const { t } = useI18n();
  const [feedback, setFeedback] = useState<string | null>(null);

  return (
    <div className="settings-list">
      <p className="home-subtitle" style={{ margin: 0 }}>
        {t.settings.subtitle}
      </p>

      {feedback && (
        <div className="status-banner is-ok" role="status" aria-live="polite">
          <span>{feedback}</span>
        </div>
      )}

      <section className="settings-section" aria-labelledby="settings-appearance-heading">
        <h2 id="settings-appearance-heading" className="settings-section-title">
          {t.settings.appearanceSection}
        </h2>
        <div className="field-row">
          <span className="field-label">{t.settings.themeLabel}</span>
          <div className="segmented" role="group" aria-label={t.settings.themeLabel}>
            {(
              [
                ["light", t.settings.themeLight],
                ["dark", t.settings.themeDark],
                ["system", t.settings.themeSystem],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`segmented-btn ${theme === val ? "is-selected" : ""}`}
                aria-pressed={theme === val}
                onClick={() => {
                  setFeedback(null);
                  onChangeTheme(val);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-language-heading">
        <h2 id="settings-language-heading" className="settings-section-title">
          {t.settings.languageSection}
        </h2>
        <div className="field-row">
          <span className="field-label">{t.settings.languageLabel}</span>
          <div className="segmented" role="group" aria-label={t.settings.languageLabel}>
            {(
              [
                ["zh-CN", t.settings.langZh],
                ["en-US", t.settings.langEn],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val}
                type="button"
                className={`segmented-btn ${locale === val ? "is-selected" : ""}`}
                aria-pressed={locale === val}
                onClick={() => {
                  setFeedback(null);
                  onChangeLocale(val);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-privacy-heading">
        <h2 id="settings-privacy-heading" className="settings-section-title">
          {t.settings.privacySection}
        </h2>
        <p className="field-hint">{t.settings.privacySessionNote}</p>
        <p className="field-hint">{t.settings.privacyLocalNote}</p>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", paddingTop: "4px" }}>
          <button
            type="button"
            className="btn"
            disabled={recentCount === 0}
            onClick={() => {
              onClearRecent();
              setFeedback(t.settings.clearRecentDone);
            }}
          >
            {t.settings.clearRecentButton} ({recentCount})
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onResetPreferences();
              setFeedback(t.settings.resetPrefsDone);
            }}
          >
            {t.settings.resetPrefsButton}
          </button>
        </div>
      </section>

      <section className="settings-section" aria-labelledby="settings-media-heading">
        <h2 id="settings-media-heading" className="settings-section-title">
          {locale === "zh-CN"
            ? "媒体组件（FFmpeg / ffprobe）"
            : "Media Components (FFmpeg / ffprobe)"}
        </h2>
        <MediaToolsSetupPanel mode="settings" />
      </section>

      <section className="settings-section" aria-labelledby="settings-ytdlp-heading">
        <h2 id="settings-ytdlp-heading" className="settings-section-title">
          {locale === "zh-CN" ? "视频下载组件（yt-dlp）" : "Video Downloader Component (yt-dlp)"}
        </h2>
        <YtdlpSetupPanel mode="settings" />
      </section>

      {runtime && (
        <section className="settings-section" aria-labelledby="settings-runtime-heading">
          <h2 id="settings-runtime-heading" className="settings-section-title">
            {t.settings.runtimeSection}
          </h2>
          <p className="field-hint mono">
            {runtime.name} v{runtime.version} · {runtime.platform}/{runtime.arch}
          </p>
        </section>
      )}
    </div>
  );
}
