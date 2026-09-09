import { IconPanel, IconPopOut } from "@rama/ui";
import type { MainView } from "./AppShell";
import { ThemePicker } from "./ThemePicker";
import { useProvidersData } from "./data/ProvidersProvider";
import { useSettingsLink } from "./data/SettingsLinkContext";
import { useWindowTabsData } from "./data/WindowTabsProvider";

// docs/REDESIGN_PLAN.md Phase R3 — the tab strip lived here (a pointer-drag reorder/tear-off
// gesture, see git history) until the sidebar became the tab list. What's left is window chrome:
// the traffic-light gap, a compact readout of the active tab (a window can still hold more than
// one — see Sidebar.tsx's handleChatClick/adoptChat — just with no visible strip, hence the
// position counter and the ⌃⇥/⌘1-9/⌘⇧O shortcuts in CommandPalette.tsx), the ⌘K pill, an explicit
// pop-out button replacing the old tear-off drag, and the Mission Control toggle. The last slot is
// always a theme picker (ThemePicker.tsx) — every window (main and popped-out/secondary alike) can
// switch its own theme, since a chat's theme is per-chat, not per-app (see ProjectsProvider's
// applyTheme wiring). Full Settings has no titlebar button in any window anymore; it's still
// reachable everywhere via ⌘, / the ⌘K command palette (CommandPalette.tsx), plus the sidebar
// footer's own entry point on the main window.
//
// docs/REDESIGN_PLAN.md Phase R5 — the main window also carries a Home/Code view switcher
// (`showViewTabs` gates the tab-readout logic below, since only the main window has a "home"
// view at all). Its UI lives in Sidebar.tsx; this titlebar never renders its own copy, even
// when the sidebar is collapsed — `showSidebarToggle` below is the only way back in that state
// (re-expand the sidebar, then use its switcher). Secondary/detached windows have no Home
// concept (no sidebar, no cross-project view), so they never get the tabs.
//
// The sidebar's own collapse/expand button lives inside Sidebar.tsx too, which is a problem
// once the sidebar is actually collapsed (width: 0) — its button collapses away with it, and
// there'd be no way back. `showSidebarToggle` renders a fallback re-expand button here, right
// next to the traffic-gap, for exactly that state.
export function Titlebar(props: {
  reserveTrafficGap: boolean;
  panelOpen: boolean;
  onTogglePanel: () => void;
  showViewTabs: boolean;
  showSidebarToggle: boolean;
  onToggleSidebar: () => void;
  view: MainView;
}) {
  const { tabs, activeTabId, popOutTab } = useWindowTabsData();
  const { providers, health } = useProvidersData();
  const { open: openSettings } = useSettingsLink();
  const activeIndex = tabs.findIndex((t) => t.id === activeTabId);
  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
  const showTabReadout = !props.showViewTabs || props.view === "code";
  // docs/PROVIDERS_PLAN.md Phase P1 — "without it, a dead key is invisible." Used to live in the
  // now-removed StatusBar footer (docs/REDESIGN_PLAN.md Phase R3); moved here rather than deleted
  // outright when that footer went away, since this is the only place a broken provider surfaces.
  const badProviders = providers.filter((p) => health[p.id]?.status === "bad");

  return (
    // "deep" (not bare) so any non-interactive point in the titlebar drags the window — a bare
    // attr here only arms the root element itself, which children fully cover, so in practice
    // only the tiny traffic-gap/spacer slivers below would ever be draggable. Tauri's drag script
    // still blocks on clickable elements/roles first, so the buttons below keep their own clicks.
    <div className="rama-titlebar" data-tauri-drag-region="deep">
      {props.reserveTrafficGap && <div className="rama-titlebar-traffic-gap" />}
      {props.showSidebarToggle && (
        <button
          className="rama-btn rama-btn-icon"
          style={{ alignSelf: "center", marginLeft: 10 }}
          onClick={props.onToggleSidebar}
          title="Expand sidebar"
        >
          <IconPanel />
        </button>
      )}
      {showTabReadout && (
        <div className="rama-titlebar-title">
          <span className={`rama-tab-dot ${activeTab?.status === "running" ? "rama-tab-dot-running" : ""}`} />
          <span className="rama-titlebar-title-text">{activeTab?.title ?? "rama"}</span>
        </div>
      )}
      <div style={{ flex: 1, minWidth: 24 }} />
      <div className="rama-titlebar-controls">
        <button
          className="rama-cmdk-pill"
          onClick={() => window.dispatchEvent(new CustomEvent("rama:toggle-palette"))}
          title="Command palette (⌘K)"
        >
          ⌘K<span style={{ opacity: 0.65 }}>commands</span>
        </button>
        {showTabReadout && tabs.length > 1 && activeTab && (
          <button
            className="rama-btn rama-btn-icon"
            onClick={() => void popOutTab(activeTab.id)}
            title="Pop out into a new window (⌘⇧O)"
          >
            <IconPopOut />
          </button>
        )}
        {showTabReadout && (
          <button className="rama-btn rama-btn-icon" onClick={props.onTogglePanel} title="Toggle Mission Control">
            <IconPanel />
          </button>
        )}
        {badProviders.length > 0 && (
          <button
            type="button"
            className="rama-titlebar-alert"
            onClick={() => openSettings({ pane: "providers", providerId: badProviders[0].id })}
            title={badProviders.length === 1 ? `${badProviders[0].label} unavailable` : `${badProviders.length} providers unavailable`}
          >
            <span className="rama-titlebar-alert-dot" />
          </button>
        )}
        <ThemePicker />
      </div>
    </div>
  );
}
