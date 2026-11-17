import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PREFERENCES,
  PREFERENCES_STORAGE_KEY,
  loadPreferences,
  recordRecentToolVisit,
  savePreferences,
  toggleFavoriteId,
} from "./preferences";

describe("preferences persistence and sanitization", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns clean defaults when storage is empty or corrupted", () => {
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, "{broken-json");
    expect(loadPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it("round-trips theme, locale, favorites, and recent tools without storing sensitive content", () => {
    let favs = toggleFavoriteId([], "D01");
    favs = toggleFavoriteId(favs, "I03");
    expect(favs).toEqual(["D01", "I03"]);
    favs = toggleFavoriteId(favs, "D01");
    expect(favs).toEqual(["I03"]);

    let recent = recordRecentToolVisit([], "D01", 100);
    recent = recordRecentToolVisit(recent, "D03", 200);
    recent = recordRecentToolVisit(recent, "D01", 300);
    expect(recent.map((r) => r.id)).toEqual(["D01", "D03"]);
    expect(recent[0]?.visitedAt).toBe(300);

    savePreferences({
      theme: "dark",
      locale: "en-US",
      favorites: favs,
      recentTools: recent,
    });

    const loaded = loadPreferences();
    expect(loaded).toEqual({
      theme: "dark",
      locale: "en-US",
      favorites: ["I03"],
      recentTools: [
        { id: "D01", visitedAt: 300 },
        { id: "D03", visitedAt: 200 },
      ],
    });
  });
});
