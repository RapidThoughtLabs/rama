import { useRef, useState } from "react";
import { getTheme, useTheme } from "@rama/ui";
import { ThemePopover } from "./ThemePopover";

/* The seal — HOME_REDESIGN_PLAN.md Phase HD2 (mock:L185-197, 777, 1472-1475): a painter's stamp
   in the corner of `.r-main` showing the active theme's name in kanji. Rendered on every view of
   every window (Decision D5). Clicking it toggles the theme popover. */
export function Seal() {
  const { themeId, themes } = useTheme();
  const theme = getTheme(themeId, themes);
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        ref={ref}
        className="r-seal"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Theme: ${theme.label}. Change appearance`}
        title={`${theme.label} theme`}
        onClick={() => setOpen((v) => !v)}
      >
        {theme.kanji}
      </button>
      <ThemePopover open={open} onClose={() => setOpen(false)} anchor={ref} />
    </>
  );
}
