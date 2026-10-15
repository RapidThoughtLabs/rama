import type { ReactNode } from "react";
import { Icon } from "@rama/ui";
import { useNavigation } from "../data/NavigationProvider";
import { WINDOW_LABEL } from "../../engine/window";

/* Top bar frame — HOME_REDESIGN_PLAN.md Phase HD1 (mock:L171-181, 767-776). 52px, transparent,
   and a window drag region ("deep", so the gaps between controls drag too). The right padding
   reserves the seal's corner. Content comes from the active view: Home's chat title (HD6), or
   the Code tab's title and actions (code/CodeTopbar.tsx, the Code plan's to restyle). */
export function Topbar({ children }: { children?: ReactNode }) {
  const nav = useNavigation();
  return (
    <header className="r-topbar" data-tauri-drag-region="deep">
      {WINDOW_LABEL === "main" && (
        <button className="r-icon-btn open-sb" title="Show sidebar" aria-label="Show sidebar" onClick={() => nav.setSidebarOpen(true)}>
          <Icon name="menu" />
        </button>
      )}
      {children}
    </header>
  );
}
