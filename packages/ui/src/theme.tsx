import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

/* Theme engine — docs/IMPLEMENTATION_PLAN.md Phase 0: "data-theme / data-accent
   + wallpaper stack ..., runtime switch, persisted."

   Phase 0 persistence is localStorage (single global default). Phase 1 moves
   this to per-chat SQLite rows (`chats.wallpaper/accent/theme`) and this
   engine's setters are what the chat-switch handler will call into. */

export type ThemeMode = "dark" | "light";
export type Accent = "plasma" | "surge" | "frost" | "void" | "dusk" | "ember";
export type Wallpaper = "indigo" | "inferno" | "rose" | "none";

export const ACCENTS: { id: Accent; label: string }[] = [
  { id: "plasma", label: "Plasma" },
  { id: "surge", label: "Surge" },
  { id: "frost", label: "Frost" },
  { id: "void", label: "Void" },
  { id: "dusk", label: "Dusk" },
  { id: "ember", label: "Ember" },
];

export const WALLPAPERS: Wallpaper[] = ["indigo", "inferno", "rose", "none"];

export interface ThemeState {
  theme: ThemeMode;
  accent: Accent;
  wallpaper: Wallpaper;
  /** 0-100, matches the prototype's "dim" preview knob. */
  dim: number;
}

const DEFAULT_STATE: ThemeState = { theme: "dark", accent: "plasma", wallpaper: "indigo", dim: 62 };
const STORAGE_KEY = "rama.theme";

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

function defaultResolveWallpaperUrl(wallpaper: Wallpaper): string {
  return wallpaper === "none" ? "none" : `url('/wallpapers/nebula-${wallpaper}.jpg')`;
}

export interface ThemeContextValue extends ThemeState {
  setTheme: (theme: ThemeMode) => void;
  setAccent: (accent: Accent) => void;
  setWallpaper: (wallpaper: Wallpaper) => void;
  setDim: (dim: number) => void;
  toggleTheme: () => void;
  cycleAccent: () => void;
  cycleWallpaper: () => void;
  /** Bulk setter — used when switching chats so theme/accent/wallpaper land in one update
      instead of three, and so the per-chat persistence effect only fires once per switch. */
  applyTheme: (partial: Partial<Pick<ThemeState, "theme" | "accent" | "wallpaper">>) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider(props: {
  children: ReactNode;
  resolveWallpaperUrl?: (wallpaper: Wallpaper) => string;
}) {
  const [state, setState] = useState<ThemeState>(loadPersisted);
  const resolveWallpaperUrl = props.resolveWallpaperUrl ?? defaultResolveWallpaperUrl;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = state.theme;
    root.dataset.accent = state.accent;
    root.style.setProperty("--wp", resolveWallpaperUrl(state.wallpaper));

    const isLight = state.theme === "light";
    const floor = isLight ? 0.93 : state.wallpaper === "none" ? 0.96 : 0;
    const veil = Math.max(state.dim / 100, floor);
    root.style.setProperty("--veil", String(veil));

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [state, resolveWallpaperUrl]);

  const setTheme = useCallback((theme: ThemeMode) => setState((s) => ({ ...s, theme })), []);
  const setAccent = useCallback((accent: Accent) => setState((s) => ({ ...s, accent })), []);
  const setWallpaper = useCallback((wallpaper: Wallpaper) => setState((s) => ({ ...s, wallpaper })), []);
  const setDim = useCallback((dim: number) => setState((s) => ({ ...s, dim })), []);
  const toggleTheme = useCallback(() => setState((s) => ({ ...s, theme: s.theme === "dark" ? "light" : "dark" })), []);
  const cycleAccent = useCallback(() => {
    setState((s) => {
      const i = ACCENTS.findIndex((a) => a.id === s.accent);
      return { ...s, accent: ACCENTS[(i + 1) % ACCENTS.length].id };
    });
  }, []);
  const cycleWallpaper = useCallback(() => {
    setState((s) => {
      const i = WALLPAPERS.indexOf(s.wallpaper);
      return { ...s, wallpaper: WALLPAPERS[(i + 1) % WALLPAPERS.length] };
    });
  }, []);
  const applyTheme = useCallback(
    (partial: Partial<Pick<ThemeState, "theme" | "accent" | "wallpaper">>) =>
      setState((s) => ({ ...s, ...partial })),
    [],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({
      ...state,
      setTheme,
      setAccent,
      setWallpaper,
      setDim,
      toggleTheme,
      cycleAccent,
      cycleWallpaper,
      applyTheme,
    }),
    [state, setTheme, setAccent, setWallpaper, setDim, toggleTheme, cycleAccent, cycleWallpaper, applyTheme],
  );

  return <ThemeContext.Provider value={value}>{props.children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
