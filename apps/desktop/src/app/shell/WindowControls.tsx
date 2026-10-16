import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/* Caption buttons for the frameless Windows build. macOS keeps its native traffic lights (overlay
   title bar, inside the sidebar's top row); Windows has no such option, so its title bar is turned
   off (tauri.windows.conf.json, drag.rs) and these take the top-right corner instead. The seal
   steps left to make room (shell.css, "Windows chrome").

   Each button is the full top-bar height and the cluster sits flush in the corner, so a
   maximized window still closes from the corner pixel; only the hover pill is inset, matching
   the top bar's own icon buttons. Glyphs are drawn in the kit's stroke style rather than Segoe's.
   Kept out of the tab order, like native caption buttons (Alt+F4 / Win+arrows cover the
   keyboard). */
export function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let alive = true;
    const sync = () => void win.isMaximized().then((m) => alive && setMaximized(m));
    sync();
    const unlisten = win.onResized(sync);
    return () => {
      alive = false;
      void unlisten.then((off) => off());
    };
  }, []);

  const win = getCurrentWindow();
  return (
    <div className="r-caption" role="group" aria-label="Window">
      <button tabIndex={-1} title="Minimize" aria-label="Minimize" onClick={() => void win.minimize()}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.5 8h9" />
        </svg>
      </button>
      <button
        tabIndex={-1}
        title={maximized ? "Restore down" : "Maximize"}
        aria-label={maximized ? "Restore down" : "Maximize"}
        onClick={() => void win.toggleMaximize()}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          {maximized ? (
            <>
              <rect x="3.5" y="5.5" width="7" height="7" rx="1.6" />
              <path d="M5.8 3.5h5a1.7 1.7 0 0 1 1.7 1.7v5" />
            </>
          ) : (
            <rect x="3.5" y="3.5" width="9" height="9" rx="1.8" />
          )}
        </svg>
      </button>
      <button tabIndex={-1} className="close" title="Close" aria-label="Close" onClick={() => void win.close()}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path d="m4 4 8 8M12 4l-8 8" />
        </svg>
      </button>
    </div>
  );
}
