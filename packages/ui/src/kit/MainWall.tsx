/* The main area's wallpaper — HOME_REDESIGN_PLAN.md Phase HD0 (mock:L167-169, 764-765). Two
   layers, image then veil, mounted inside `.r-main` only; the sidebar is an opaque --sidebar fill.
   Replaces the old six-layer WallpaperStack (dot field, vignette, accent wash and grain are gone).
   Everything is token-driven (--wp, --wp-fit, --wp-position, --veil from seedTokens), so this never
   needs the theme itself. */
export function MainWall() {
  return (
    <>
      <div className="r-wall" aria-hidden="true" />
      <div className="r-veil" aria-hidden="true" />
    </>
  );
}
