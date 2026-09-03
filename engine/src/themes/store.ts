import { existsSync, mkdirSync, readFileSync, readdirSync, watch } from "node:fs";
import { join, normalize } from "node:path";
import { RAMA_HOME } from "../db/index";

// User-authored themes — SETTINGS_PLAN.md Phase S1's "two sources: bundled builtins and
// ~/.rama/themes". This module only ever reads; the derivation math (ground→surface ramp,
// accent-derived tokens, preview swatches) lives in packages/ui/src/themes.ts's parseTheme, which
// this process can't import (that file uses Vite's import.meta.glob, a build-time-only
// construct — the frontend re-parses what this route returns). The engine's job is: find the
// files, hand back whatever's valid JSON, and say what wasn't.
export const THEMES_HOME = join(RAMA_HOME, "themes");

const README = `# Rama themes

Drop a \`<id>.json\` file in this folder to add a theme, or add a file whose
name matches a bundled theme's id (e.g. \`kanagawa.json\`) to override it —
a user theme always wins over a builtin of the same id.

Required fields: "id" (must match the filename), "label", "family" ("blue" |
"red" | "green" — just a gallery grouping, pick whichever reads best), "mode"
("dark" | "light"), and four colours: "ground", "ink", "inkLoud", "accent".

See example.json in this folder for the full shape, including the optional
"wallpaper", "semantic", "texture" and "tokens" (raw CSS-variable escape
hatch) blocks. Rama watches this folder — edit a file and save, and every
open window restyles without a restart.
`;

const EXAMPLE = {
  id: "example",
  label: "Example",
  family: "blue",
  mode: "dark",
  ground: "#0d1420",
  ink: "#dbe4ec",
  inkLoud: "#f2ecdd",
  accent: "#6fb6e6",
  semantic: { bad: "#e8808a" },
  texture: { grain: 0.28, vignette: 0.58 },
  wallpaper: { css: "radial-gradient(120% 90% at 50% 0%, rgba(111,182,230,0.18), transparent 60%)", veil: 0.6 },
};

export function ensureThemesHome(): void {
  const isNew = !existsSync(THEMES_HOME);
  mkdirSync(THEMES_HOME, { recursive: true });
  if (isNew) {
    Bun.write(join(THEMES_HOME, "README.md"), README);
    Bun.write(join(THEMES_HOME, "example.json"), JSON.stringify(EXAMPLE, null, 2) + "\n");
  }
}

export interface ThemeFileError {
  file: string;
  message: string;
}

// Deliberately loose — this is NOT the schema the frontend enforces (parseTheme in
// packages/ui/src/themes.ts is the real validator). This just needs enough to reject garbage
// before it goes over the wire and to make the file/filename-match error legible here too, since
// that specific mismatch is confusing enough to want two chances to catch it.
function validateShape(raw: unknown, stem: string): string | null {
  if (typeof raw !== "object" || raw === null) return "not a JSON object";
  const t = raw as Record<string, unknown>;
  for (const key of ["id", "label", "family", "mode", "ground", "ink", "inkLoud", "accent"]) {
    if (typeof t[key] !== "string" || !(t[key] as string).trim()) return `missing required field "${key}"`;
  }
  if (t.id !== stem) return `"id" ("${String(t.id)}") must match the filename`;
  return null;
}

export function listUserThemes(): { themes: unknown[]; errors: ThemeFileError[] } {
  ensureThemesHome();
  const themes: unknown[] = [];
  const errors: ThemeFileError[] = [];
  for (const file of readdirSync(THEMES_HOME)) {
    if (!file.endsWith(".json") || file === "example.json") continue;
    const stem = file.slice(0, -".json".length);
    try {
      const raw = JSON.parse(readFileSync(join(THEMES_HOME, file), "utf8"));
      const problem = validateShape(raw, stem);
      if (problem) errors.push({ file, message: problem });
      else themes.push(raw);
    } catch (err) {
      errors.push({ file, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { themes, errors };
}

// Resolves a wallpaper asset filename against THEMES_HOME (themes and their image assets live
// flat, side by side — "drop a file in the folder" is the whole authoring model), rejecting
// anything that escapes it. This is a path join off user-controlled input (the URL segment) in a
// process that can read the whole home directory, so containment is checked after normalising
// rather than trusted from the shape of the input.
export function resolveThemeAsset(file: string): string | null {
  const path = normalize(join(THEMES_HOME, file));
  if (!path.startsWith(THEMES_HOME + "/")) return null;
  return existsSync(path) ? path : null;
}

let watching = false;

export function watchThemes(onChange: () => void): void {
  if (watching) return;
  watching = true;
  ensureThemesHome();
  let timer: ReturnType<typeof setTimeout> | null = null;
  watch(THEMES_HOME, { persistent: false }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, 150);
  });
}
