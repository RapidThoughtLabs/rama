import { DotFieldBackground } from "./DotFieldBackground";
import { getTheme } from "./themes";
import { useTheme } from "./theme";

/* Wallpaper stack — Rama.dc.html: "image → veil → vignette → accent wash → grain".
   SETTINGS_PLAN.md Phase S0: the wallpaper (image/veil) is theme-authored data now, not a user
   setting — a theme without a `wallpaper` block (Sumi) renders bare ground, so those two layers
   are conditional on the active theme rather than always mounted with --wp defaulting to "none".
   The other four layers are the app's texture, not the wallpaper, and always render — they're
   pure token math (packages/ui/src/tokens.css's [data-rmode] blocks) so they react to
   accent/theme changes on their own. */
export function WallpaperStack() {
  const { themeId, themes } = useTheme();
  const theme = getTheme(themeId, themes);
  const hasWallpaper = !!(theme.wallpaper && (theme.wallpaper.image || theme.wallpaper.css));

  return (
    <div className="rama-wallpaper-stack" aria-hidden="true">
      <DotFieldBackground />
      {hasWallpaper && (
        <>
          <div className="rama-wallpaper-image" />
          <div className="rama-wallpaper-veil" />
        </>
      )}
      <div className="rama-wallpaper-vignette" />
      <div className="rama-wallpaper-wash" />
      <div className="rama-wallpaper-grain" />
    </div>
  );
}
