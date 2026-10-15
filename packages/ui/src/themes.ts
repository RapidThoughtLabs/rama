/* Theme registry — SETTINGS_PLAN.md Phase S1/S2 (supersedes docs/REDESIGN_PLAN.md Phase R0's
   original three-theme table).

   A theme is a JSON file in ./themes/*.json plus, at runtime, anything the user drops into
   ~/.rama/themes (mergeThemes below — user themes win on id collision, see the engine's
   GET /themes route). Each file supplies four required colours (ground/ink/inkLoud/accent) and
   an optional wallpaper/semantic/texture/tokens block; everything else — the ~24-token CSS
   contract packages/ui/src/tokens.css actually renders — is derived, either here in JS
   (seedTokens, for tokens that must be raw "R, G, B" triplets or hex) or in tokens.css's two
   [data-rmode] formula blocks (for tokens that are pure oklch()/rgb() relative-colour math off
   --accent and don't care which theme set it). Adding a theme is adding one JSON file; nothing
   here should need to change. */

import { adjustLightness, GROUND_RAMP, rgbTriplet } from "./theme-color";

export type ThemeFamily = "blue" | "red" | "green";
export type ThemeMode = "dark" | "light";
// A directory of files can't be a compile-time union — safety moves to getTheme()'s runtime
// fallback (SETTINGS_PLAN.md Phase S1's "ThemeId stops being a union").
export type ThemeId = string;

export interface ThemeWallpaper {
  /** Resolved as a URL — for a builtin, `/wallpapers/<file>`; for a user theme, the engine's
      `/themes/:id/asset/:file` route. Absent + no `css` means no wallpaper: the image/veil
      layers don't render at all rather than rendering an invisible one. */
  image?: string;
  /** Raw CSS background-image value (a gradient, typically). With `image` too, it's layered
      underneath the image — it shows wherever the image doesn't cover (a `fit` like "100% auto"). */
  css?: string;
  /** 0 = image/gradient at full strength, 1 = fully covered by --page-bg. Required with `image`
      or `css` — the safe failure (a theme that forgets it) is fully covered, not a photo at full
      strength behind body text. */
  veil: number;
  /** mix-blend-mode for the image/gradient layer. Default "normal". */
  blend?: string;
  /** background-size. Default "cover". */
  fit?: string;
  /** background-position. Default "center". */
  position?: string;
}

export interface ThemeSemantic {
  good?: string;
  warn?: string;
  bad?: string;
  bad2?: string;
}

/** Dead since HOME_REDESIGN_PLAN.md Phase HD0 retired the grain/vignette layers — still parsed so
    older theme files load, but nothing reads it. */
export interface ThemeTexture {
  grain?: number;
  vignette?: number;
}

export interface RamaTheme {
  id: ThemeId;
  label: string;
  /** The seal's text (HOME_REDESIGN_PLAN.md Phase HD2) — the theme's name in kanji, set
      vertically in the corner stamp and the theme popover's mini-seals. Optional for user themes;
      resolved to the first character of `label` by parseTheme when absent. */
  kanji: string;
  family: ThemeFamily;
  mode: ThemeMode;
  ground: string;
  ink: string;
  inkLoud: string;
  accent: string;
  semantic?: ThemeSemantic;
  texture?: ThemeTexture;
  wallpaper?: ThemeWallpaper;
  /** Raw token escape hatch — applied last, after every derived value below. Without this, the
      first theme that wants to break a derivation would force a schema change. */
  tokens?: Record<string, string>;
  /** Set when this theme came from ~/.rama/themes and replaced a builtin of the same id
      (mergeThemes below) — the gallery marks these so "kanagawa looks wrong" doesn't turn into a
      twenty-minute debugging session over a file someone forgot they wrote. */
  shadowsBuiltin?: boolean;
  /** Gallery swatch preview — computed, not authored, so there's nothing here to keep in sync. */
  preview: { bg: string; surface: string; accent: string; ink: string };
}

const REQUIRED_KEYS = ["id", "label", "family", "mode", "ground", "ink", "inkLoud", "accent"] as const;

export class ThemeParseError extends Error {}

/** Validates + fills in the computed `preview`. Throws ThemeParseError with a message fit to
    show a user (SETTINGS_PLAN.md Phase S1: "errors surface in the pane, never a silent skip"). */
export function parseTheme(raw: unknown, filenameStem: string): RamaTheme {
  if (typeof raw !== "object" || raw === null) {
    throw new ThemeParseError(`${filenameStem}.json — not a JSON object`);
  }
  const t = raw as Record<string, unknown>;
  for (const key of REQUIRED_KEYS) {
    if (typeof t[key] !== "string" || !(t[key] as string).trim()) {
      throw new ThemeParseError(`${filenameStem}.json — missing required field "${key}"`);
    }
  }
  if (t.id !== filenameStem) {
    throw new ThemeParseError(`${filenameStem}.json — "id" ("${String(t.id)}") must match the filename`);
  }
  if (t.mode !== "dark" && t.mode !== "light") {
    throw new ThemeParseError(`${filenameStem}.json — "mode" must be "dark" or "light"`);
  }
  if (t.family !== "blue" && t.family !== "red" && t.family !== "green") {
    throw new ThemeParseError(`${filenameStem}.json — "family" must be "blue", "red" or "green"`);
  }
  const wallpaper = t.wallpaper as ThemeWallpaper | undefined;
  if (wallpaper && (wallpaper.image || wallpaper.css) && typeof wallpaper.veil !== "number") {
    throw new ThemeParseError(`${filenameStem}.json — "wallpaper" sets an image/css but no "veil"`);
  }

  const ground = t.ground as string;
  const surface = adjustLightness(ground, GROUND_RAMP.surface);
  const accent = t.accent as string;

  return {
    id: t.id as string,
    label: t.label as string,
    kanji: typeof t.kanji === "string" && t.kanji.trim() ? t.kanji.trim() : Array.from(t.label as string)[0],
    family: t.family as ThemeFamily,
    mode: t.mode as ThemeMode,
    ground,
    ink: t.ink as string,
    inkLoud: t.inkLoud as string,
    accent,
    semantic: t.semantic as ThemeSemantic | undefined,
    texture: t.texture as ThemeTexture | undefined,
    wallpaper,
    tokens: t.tokens as Record<string, string> | undefined,
    preview: { bg: ground, surface, accent, ink: t.inkLoud as string },
  };
}

const DEFAULT_SEMANTIC: Record<ThemeMode, Required<ThemeSemantic>> = {
  dark: { good: "#8cc9a0", warn: "#e6c384", bad: "#e8808a", bad2: "#f0a0a8" },
  light: { good: "#2e7d4f", warn: "#a6791f", bad: "#b33a3a", bad2: "#8f2a2a" },
};

/** A theme's wallpaper as a CSS background-image value ("none" without one). Shared by
    seedTokens and the theme popover's swatch previews, which render *other* themes. */
export function wallpaperCss(theme: RamaTheme): string {
  const wp = theme.wallpaper;
  if (!wp || (!wp.image && !wp.css)) return "none";
  if (wp.image && wp.css) return `url('${wp.image}'), ${wp.css}`;
  return wp.css ?? `url('${wp.image}')`;
}

/** All CSS custom properties that must be raw hex/"R, G, B" strings (used directly inside
    `rgba(var(--x), a)` elsewhere in the app, or as inline-style strings in .tsx) — anything that
    can instead be an oklch()/rgb() *relative*-colour formula off --accent lives in tokens.css's
    two [data-rmode] blocks and doesn't need to be computed here. */
export function seedTokens(theme: RamaTheme): Record<string, string> {
  const deep = adjustLightness(theme.ground, GROUND_RAMP.deep);
  const surface = adjustLightness(theme.ground, GROUND_RAMP.surface);
  const elevated = adjustLightness(theme.ground, GROUND_RAMP.elevated);
  const semantic = { ...DEFAULT_SEMANTIC[theme.mode], ...theme.semantic };

  const out: Record<string, string> = {
    "--accent": theme.accent,
    "--bg-base": theme.ground,
    "--bg-deep": deep,
    "--bg-surface": surface,
    "--bg-elevated": elevated,
    "--sf-hi": rgbTriplet(elevated),
    "--sf-lo": rgbTriplet(surface),
    "--rc": rgbTriplet(deep),
    "--ink": rgbTriplet(theme.ink),
    // Kit names (kit/tokens.css, HOME_REDESIGN_PLAN.md Phase HD0) — the mockup's hex --ink is
    // --ink-c here since --ink above is already a triplet.
    "--ground": theme.ground,
    "--ink-c": theme.ink,
    "--text-1": theme.ink,
    "--ink-hi": theme.inkLoud,
    "--good": semantic.good,
    "--warn": semantic.warn,
    "--bad": semantic.bad,
    "--bad-2": semantic.bad2,
    "--warn-rgb": rgbTriplet(semantic.warn),
  };

  const wp = theme.wallpaper;
  if (wp && (wp.image || wp.css)) {
    out["--wp"] = wallpaperCss(theme);
    out["--veil"] = String(wp.veil);
    out["--wp-blend"] = wp.blend ?? "normal";
    out["--wp-fit"] = wp.fit ?? "cover";
    out["--wp-position"] = wp.position ?? "center";
  } else {
    out["--wp"] = "none";
    out["--veil"] = "1";
  }

  if (theme.tokens) Object.assign(out, theme.tokens);
  return out;
}

const files = import.meta.glob("./themes/*.json", { eager: true, import: "default" }) as Record<string, unknown>;

function stemOf(path: string): string {
  return path.replace(/^.*\//, "").replace(/\.json$/, "");
}

export const BUILTIN_THEMES: RamaTheme[] = Object.entries(files).map(([path, raw]) => parseTheme(raw, stemOf(path)));

// Display order within the gallery — SETTINGS_PLAN.md Phase S2: three rows of three, family as
// the row axis, light member first within each row. `family` + `mode` alone can't disambiguate
// the two dark members of a family (a "hero" and a "deep/bold"), so this is an explicit list
// rather than a derived sort.
const DISPLAY_ORDER = ["nami", "kanagawa", "sumi", "sakura", "tsubaki", "shu", "wakaba", "matsu", "rokusho"];

export function sortThemes(themes: RamaTheme[]): RamaTheme[] {
  return [...themes].sort((a, b) => {
    const ia = DISPLAY_ORDER.indexOf(a.id);
    const ib = DISPLAY_ORDER.indexOf(b.id);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.label.localeCompare(b.label);
  });
}

// `foam` was renamed to `nami` (SETTINGS_PLAN.md Phase S2) — a chat row or localStorage blob
// persisted under the old id resolves here instead of a SQL migration.
const ALIASES: Record<string, string> = { foam: "nami" };

/** User themes (from ~/.rama/themes, fetched over HTTP) merged over the bundled set — a user
    theme whose id matches a builtin's replaces it and is flagged `shadowsBuiltin`. Order doesn't
    matter for lookup; sortThemes handles gallery display order. */
export function mergeThemes(userThemes: RamaTheme[]): RamaTheme[] {
  const byId = new Map(BUILTIN_THEMES.map((t) => [t.id, t]));
  for (const t of userThemes) {
    byId.set(t.id, byId.has(t.id) ? { ...t, shadowsBuiltin: true } : t);
  }
  return [...byId.values()];
}

export const DEFAULT_THEME_ID: ThemeId = "kanagawa";

export function getTheme(id: string, themes: RamaTheme[] = BUILTIN_THEMES): RamaTheme {
  const resolved = ALIASES[id] ?? id;
  return themes.find((t) => t.id === resolved) ?? themes.find((t) => t.id === DEFAULT_THEME_ID) ?? themes[0];
}

// Back-compat named export — most call sites (SettingsModal, ThemePicker) now prefer
// `useTheme().themes` (the live-merged list including any ~/.rama/themes entries) but a couple of
// places only ever want "the themes this build ships with".
export const THEMES = BUILTIN_THEMES;
