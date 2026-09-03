import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { ThemeFileErrorDTO } from "@rama/protocol";
import { ThemeParseError, parseTheme, type RamaTheme } from "@rama/ui";
import { fetchThemes, getEngineConnection } from "../../engine/client";
import { onThemesChanged } from "../../engine/ws";

// SETTINGS_PLAN.md Phase S1 — user themes from ~/.rama/themes, fetched once and kept live via the
// engine's fs.watch push (onThemesChanged). Sits outside <ThemeProvider> (App.tsx) since
// ThemeProvider needs the resolved list as a prop to apply/cycle/persist against; this is the one
// piece of theme state that talks to the engine at all.
export interface ThemesDataValue {
  /** Parsed, ready to hand to <ThemeProvider themes={...}>. Empty while the first fetch is in
      flight — ThemeProvider's own default (BUILTIN_THEMES) covers that window. */
  userThemes: RamaTheme[];
  /** Both engine-side structural failures (GET /themes' own `errors`) and ones parseTheme caught
      that the engine's looser check let through — SETTINGS_PLAN.md Phase S1: "never a silent
      skip". */
  errors: { file: string; message: string }[];
  loading: boolean;
}

const ThemesContext = createContext<ThemesDataValue | null>(null);

// A JSON author writes a bare filename ("pines.jpg") for a wallpaper image; the engine serves it
// at GET /themes/asset/:file. An absolute path (a builtin's "/wallpapers/...") is left alone.
async function resolveAssetUrls(theme: RamaTheme): Promise<RamaTheme> {
  const image = theme.wallpaper?.image;
  if (!image || image.startsWith("/") || image.startsWith("http")) return theme;
  const { url, token } = await getEngineConnection();
  return {
    ...theme,
    wallpaper: { ...theme.wallpaper!, image: `${url}/themes/asset/${encodeURIComponent(image)}?token=${encodeURIComponent(token)}` },
  };
}

export function ThemesProvider({ children }: { children: ReactNode }) {
  const [userThemes, setUserThemes] = useState<RamaTheme[]>([]);
  const [errors, setErrors] = useState<ThemeFileErrorDTO[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const res = await fetchThemes();
      const parsed: RamaTheme[] = [];
      const parseErrors: ThemeFileErrorDTO[] = [...res.errors];
      for (const raw of res.themes) {
        const stem = typeof raw === "object" && raw && "id" in raw ? String((raw as { id: unknown }).id) : "unknown";
        try {
          parsed.push(await resolveAssetUrls(parseTheme(raw, stem)));
        } catch (err) {
          parseErrors.push({ file: `${stem}.json`, message: err instanceof ThemeParseError ? err.message : String(err) });
        }
      }
      setUserThemes(parsed);
      setErrors(parseErrors);
    } catch (err) {
      console.error("[rama] failed to load user themes", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return onThemesChanged(() => void reload());
  }, [reload]);

  return <ThemesContext.Provider value={{ userThemes, errors, loading }}>{children}</ThemesContext.Provider>;
}

export function useThemesData(): ThemesDataValue {
  const ctx = useContext(ThemesContext);
  if (!ctx) throw new Error("useThemesData must be used within a ThemesProvider");
  return ctx;
}
