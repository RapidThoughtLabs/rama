import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, getTheme, seedTokens, sortThemes, type RamaTheme, type ThemeId } from "./themes";

/* Theme engine — SETTINGS_PLAN.md Phase S0/S1 (supersedes docs/REDESIGN_PLAN.md Phase R0's
   version, which also owned a per-user wallpaper/dim setting; both are gone — a theme's
   wallpaper is authored data now, seeded by seedTokens() like every other token).

   One app-wide theme (HOME_REDESIGN_PLAN.md Decision D1): chats no longer carry their own, so
   `chats.theme_id` is a dead column. State persists to localStorage, and every window follows it
   — a change in one window reaches the others through the `storage` event.

   Also caches the *resolved seed tokens* of the active theme, not just its id — SETTINGS_PLAN.md
   Phase S1's first-paint fix. A theme fetched from ~/.rama/themes isn't available until the
   engine responds; without a cached copy of what it resolved to last time, a persisted themeId
   naming a user theme flashes the default on every launch.

   `fontScale` and `reading` live in the same state/storage blob. */

// HOME_REDESIGN_PLAN.md Decision D2 — the theme popover's three steps (mock:L832), replacing
// S3's four. Stored values from the old ramp snap to the nearest step in loadPersisted().
export type FontScale = 0.92 | 1 | 1.1;
export const FONT_SCALES: { value: FontScale; label: string }[] = [
  { value: 0.92, label: "Smaller" },
  { value: 1, label: "Default" },
  { value: 1.1, label: "Larger" },
];

/** HOME_REDESIGN_PLAN.md Phase HD0 — the popover's "Reply font" control: Literata or Instrument
    Sans for assistant prose. Global and per window like fontScale, never per chat. */
export type ReadingFont = "serif" | "sans";

export interface ThemeState {
  themeId: ThemeId;
  fontScale: FontScale;
  reading: ReadingFont;
}

const DEFAULT_STATE: ThemeState = { themeId: DEFAULT_THEME_ID, fontScale: 1, reading: "serif" };
const STORAGE_KEY = "rama.theme";
const SEED_CACHE_KEY = "rama.theme.seed";

function nearestFontScale(v: unknown): FontScale {
  const n = Number(v);
  if (!Number.isFinite(n)) return 1;
  return n < 0.96 ? 0.92 : n < 1.05 ? 1 : 1.1;
}

function loadPersisted(): ThemeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      fontScale: nearestFontScale(parsed.fontScale ?? 1),
      reading: parsed.reading === "sans" ? "sans" : "serif",
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function applyTokens(tokens: Record<string, string>): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(k, v);
}

// Runs once at module load, synchronously, before React has painted anything — applies whatever
// theme was cached from the previous launch so there's no flash of the default theme while
// ThemeProvider's own effect (which needs the merged theme list, possibly still loading over
// HTTP) catches up. Safe to re-apply the same values a moment later; this is purely a paint-order
// optimization, not a second source of truth.
(function applyPersistedThemeSync() {
  if (typeof window === "undefined") return;
  try {
    const cached = window.localStorage.getItem(SEED_CACHE_KEY);
    const persisted = loadPersisted();
    document.documentElement.dataset.rtheme = persisted.themeId;
    document.documentElement.style.setProperty("--font-scale", String(persisted.fontScale));
    document.documentElement.dataset.reading = persisted.reading;
    if (cached) applyTokens(JSON.parse(cached));
  } catch {
    // best-effort — ThemeProvider's effect below is the real source of truth
  }
})();

export interface ThemeContextValue extends ThemeState {
  /** The full available set — bundled builtins merged with anything from ~/.rama/themes, sorted
      for gallery display. Defaults to builtins only when no app-level merge is provided (e.g. a
      consumer of @rama/ui with no engine connection). */
  themes: RamaTheme[];
  setThemeId: (themeId: ThemeId) => void;
  cycleTheme: () => void;
  setFontScale: (fontScale: FontScale) => void;
  setReading: (reading: ReadingFont) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children, themes }: { children: ReactNode; themes?: RamaTheme[] }) {
  const [state, setState] = useState<ThemeState>(loadPersisted);
  const resolvedThemes = useMemo(() => sortThemes(themes ?? BUILTIN_THEMES), [themes]);

  useEffect(() => {
    const theme = getTheme(state.themeId, resolvedThemes);
    const root = document.documentElement;
    root.dataset.rtheme = theme.id;
    root.dataset.rmode = theme.mode;
    const seeds = seedTokens(theme);
    applyTokens(seeds);
    root.style.setProperty("--font-scale", String(state.fontScale));
    root.dataset.reading = state.reading;

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem(SEED_CACHE_KEY, JSON.stringify(seeds));
  }, [state, resolvedThemes]);

  // Another window changed the theme (Decision D1). Re-writing the same value back from the
  // effect above doesn't echo, since setItem with an unchanged value fires no storage event.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === STORAGE_KEY && e.newValue) setState(loadPersisted());
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setThemeId = useCallback((themeId: ThemeId) => setState((s) => ({ ...s, themeId })), []);
  const cycleTheme = useCallback(() => {
    setState((s) => {
      const i = resolvedThemes.findIndex((t) => t.id === s.themeId);
      return { ...s, themeId: resolvedThemes[(i + 1) % resolvedThemes.length].id };
    });
  }, [resolvedThemes]);
  const setFontScale = useCallback((fontScale: FontScale) => setState((s) => ({ ...s, fontScale })), []);
  const setReading = useCallback((reading: ReadingFont) => setState((s) => ({ ...s, reading })), []);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, themes: resolvedThemes, setThemeId, cycleTheme, setFontScale, setReading }),
    [state, resolvedThemes, setThemeId, cycleTheme, setFontScale, setReading],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
