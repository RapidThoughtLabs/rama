import type { RefObject } from "react";
import { FONT_SCALES, Popover, getTheme, sortThemes, useTheme, wallpaperCss } from "@rama/ui";
import type { ReadingFont, RamaTheme } from "@rama/ui";

/* The theme popover — HOME_REDESIGN_PLAN.md Phase HD2 (mock:L631-656, 826-837, 1480-1494). Opens
   from the seal. A swatch applies its theme at once and leaves the popover open (mock:L2039); the
   two option rows write text size and reply font. The theme is app-wide (Decision D1), so this is
   the only theme writer besides Settings › Appearance. */

const READING: { value: ReadingFont; label: string }[] = [
  { value: "serif", label: "Serif" },
  { value: "sans", label: "Sans" },
];

export function ThemePopover({
  open,
  onClose,
  anchor,
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null>;
}) {
  const { themeId, themes, fontScale, reading, setThemeId, setFontScale, setReading } = useTheme();
  const active = getTheme(themeId, themes);

  return (
    <Popover open={open} onClose={onClose} anchor={anchor} placement="fixed" className="r-theme-pop" role="dialog" aria-label="Appearance">
      <h3>Theme</h3>
      <p className="sub">
        {active.label}, {active.mode === "light" ? "light" : "dark"}. Applies to Home and Code.
      </p>
      <div className="r-swatches" role="radiogroup" aria-label="Theme">
        {sortThemes(themes).map((t) => (
          <Swatch key={t.id} theme={t} checked={t.id === active.id} onSelect={() => setThemeId(t.id)} />
        ))}
      </div>
      <div className="divider" />
      <div className="r-opt">
        <span>Text size</span>
        <div className="r-mini-seg">
          {FONT_SCALES.map((s) => (
            <button key={s.value} aria-pressed={fontScale === s.value} onClick={() => setFontScale(s.value)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      <div className="r-opt">
        <span>Reply font</span>
        <div className="r-mini-seg">
          {READING.map((r) => (
            <button key={r.value} aria-pressed={reading === r.value} onClick={() => setReading(r.value)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </Popover>
  );
}

/* Built from the theme's own values, not the live tokens, so every swatch shows its own theme. */
function Swatch({ theme, checked, onSelect }: { theme: RamaTheme; checked: boolean; onSelect: () => void }) {
  const wp = wallpaperCss(theme);
  const veil = theme.wallpaper && wp !== "none" ? theme.wallpaper.veil : 1;
  return (
    <button className="r-swatch" role="radio" aria-checked={checked} onClick={onSelect}>
      <span className="pv" style={{ background: theme.ground }}>
        <span className="wp" style={{ backgroundImage: wp }} />
        <span className="vl" style={{ background: theme.ground, opacity: Math.min(veil, 0.7) }} />
        <span className="ln a" style={{ background: theme.ink }} />
        <span className="ln b" style={{ background: theme.ink }} />
        <span className="mini-seal" style={{ background: theme.accent, color: theme.ground }}>
          {theme.kanji}
        </span>
      </span>
      <span className="nm">{theme.label}</span>
      <span className="md">{theme.mode === "light" ? "Light" : "Dark"}</span>
    </button>
  );
}
