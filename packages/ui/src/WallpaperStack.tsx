import { DotFieldBackground } from "./DotFieldBackground";

/* Wallpaper stack — Rama.dc.html: "image → veil → vignette → accent wash → grain".
   --wp / --veil are runtime custom properties set by the theme engine
   (packages/ui/src/theme.tsx); the other layers are pure token math so they
   react to accent/theme changes automatically. */
export function WallpaperStack() {
  return (
    <div className="rama-wallpaper-stack" aria-hidden="true">
      <DotFieldBackground />
      <div className="rama-wallpaper-image" />
      <div className="rama-wallpaper-veil" />
      <div className="rama-wallpaper-vignette" />
      <div className="rama-wallpaper-wash" />
      <div className="rama-wallpaper-grain" />
    </div>
  );
}
