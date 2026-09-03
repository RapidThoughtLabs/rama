import { useEffect, useRef, useState } from "react";
import { IconBrush, useTheme, type RamaTheme, type ThemeFamily } from "@rama/ui";

// Titlebar quick-theme control (main window only — see Titlebar.tsx). A lighter-weight sibling
// of SettingsModal's AppearancePane theme gallery: same swatch/dot/label language, just the
// theme picker on its own with nothing else from Settings, since the sidebar footer already has
// a full "open settings" entry point (Sidebar.tsx's rama-sidebar-account button).
//
// SETTINGS_PLAN.md Phase S2 — grouped by family like the settings gallery, same 3-row shape, just
// inside a dropdown instead of a settings pane.
const FAMILY_ORDER: ThemeFamily[] = ["blue", "red", "green"];

function swatchStyle(t: RamaTheme) {
  const wp = t.wallpaper;
  if (!wp || (!wp.image && !wp.css)) return { background: t.preview.bg };
  return {
    background: t.preview.bg,
    backgroundImage: wp.css ?? `url('${wp.image}')`,
    backgroundSize: wp.fit ?? "cover",
    backgroundPosition: wp.position ?? "center",
  };
}

export function ThemePicker() {
  const { themeId, themes, setThemeId } = useTheme();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  return (
    <div className="rama-theme-picker" ref={rootRef}>
      <button className="rama-btn rama-btn-icon" onClick={() => setOpen((v) => !v)} title="Theme">
        <IconBrush />
      </button>
      {open && (
        <div className="rama-theme-picker-menu">
          {FAMILY_ORDER.map((family) => {
            const members = themes.filter((t) => t.family === family);
            if (members.length === 0) return null;
            return (
              <div key={family} className="rama-theme-picker-row">
                {members.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`rama-theme-picker-swatch ${themeId === t.id ? "rama-theme-picker-swatch-active" : ""}`}
                    style={swatchStyle(t)}
                    onClick={() => {
                      setThemeId(t.id);
                      setOpen(false);
                    }}
                    title={t.label}
                  >
                    <span className="rama-theme-picker-dot" style={{ background: t.preview.accent }} />
                    <span className="rama-theme-picker-label" style={{ color: t.preview.ink }}>
                      {t.label}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
