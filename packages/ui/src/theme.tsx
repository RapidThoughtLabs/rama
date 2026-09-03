import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { BUILTIN_THEMES, DEFAULT_THEME_ID, getTheme, seedTokens, sortThemes, type RamaTheme, type ThemeId } from "./themes";

/* Theme engine — SETTINGS_PLAN.md Phase S0/S1 (supersedes docs/REDESIGN_PLAN.md Phase R0's
   version, which also owned a per-user wallpaper/dim setting; both are gone — a theme's
   wallpaper is authored data now, seeded by seedTokens() like every other token).

   Persistence here is localStorage (single global default) for a window that hasn't loaded a
   chat yet; once a chat is active its theme lives in SQLite (`chats.theme_id`) and this engine's
   setter is what the chat-switch handler calls into via `applyTheme`.

   Also caches the *resolved seed tokens* of the active theme, not just its id — SETTINGS_PLAN.md
   Phase S1's first-paint fix. A theme fetched from ~/.rama/themes isn't available until the
   engine responds; without a cached copy of what it resolved to last time, a persisted themeId
   naming a user theme flashes the default on every launch.

   `fontScale` (SETTINGS_PLAN.md Phase S3) lives in this same state/storage blob for convenience,
   but is deliberately NOT part of the per-chat sync path below (applyTheme's partial type only
   ever accepts `themeId`) — a chat's theme travels with it (SQLite's chats.theme_id, R3's
   pop-out-window risk register), but font size is a reading preference of this window, not
   something a chat should carry or overwrite when you switch to one authored on a different
   machine/scale. */

export type FontScale = 0.9 | 1 | 1.12 | 1.25;
export const FONT_SCALES: { value: FontScale; label: string }[] = [
  { value: 0.9, label: "compact" },
  { value: 1, label: "default" },
  { value: 1.12, label: "large" },
  { value: 1.25, label: "larger" },
];

export interface ThemeState {
  themeId: ThemeId;
  fontScale: FontScale;
}

const DEFAULT_STATE: ThemeState = { themeId: DEFAULT_THEME_ID, fontScale: 1 };
const STORAGE_KEY = "rama.theme";
const SEED_CACHE_KEY = "rama.theme.seed";

function loadPersisted(): ThemeState {
  if (typeof window === "undefined") return DEFAULT_STATE;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
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
  /** Bulk setter — used when switching chats so the persistence effect only fires once per
      switch instead of per-field. Only `themeId` flows through here (S0 dropped wallpaper/dim,
      which used to also flow through this) — `fontScale` deliberately doesn't, so switching chats
      never touches it. */
  applyTheme: (partial: Partial<Pick<ThemeState, "themeId">>) => void;
  setFontScale: (fontScale: FontScale) => void;
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

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    window.localStorage.setItem(SEED_CACHE_KEY, JSON.stringify(seeds));
  }, [state, resolvedThemes]);

  const setThemeId = useCallback((themeId: ThemeId) => setState((s) => ({ ...s, themeId })), []);
  const cycleTheme = useCallback(() => {
    setState((s) => {
      const i = resolvedThemes.findIndex((t) => t.id === s.themeId);
      return { ...s, themeId: resolvedThemes[(i + 1) % resolvedThemes.length].id };
    });
  }, [resolvedThemes]);
  const applyTheme = useCallback(
    (partial: Partial<Pick<ThemeState, "themeId">>) => setState((s) => ({ ...s, ...partial })),
    [],
  );
  const setFontScale = useCallback((fontScale: FontScale) => setState((s) => ({ ...s, fontScale })), []);

  const value = useMemo<ThemeContextValue>(
    () => ({ ...state, themes: resolvedThemes, setThemeId, cycleTheme, applyTheme, setFontScale }),
    [state, resolvedThemes, setThemeId, cycleTheme, applyTheme, setFontScale],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
