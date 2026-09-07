import { useState } from "react";
import type { CSSProperties } from "react";
import { WallpaperStack } from "@rama/ui";
import { Titlebar } from "./Titlebar";
import { Sidebar } from "./Sidebar";
import { ChatColumn } from "./ChatColumn";
import { CommandPalette } from "./CommandPalette";
import { DocsPage } from "./DocsPage";
import { HomePane } from "./HomePane";
import { AgentTerminalBridge } from "./mission-control/AgentTerminalBridge";
import { AgentWebBridge } from "./mission-control/AgentWebBridge";
import { MissionControl } from "./mission-control/MissionControl";
import { useMissionControlGeometry } from "./mission-control/useMissionControlGeometry";
import { SettingsModal } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { ToolboxPage } from "./ToolboxPage";
import { useSettingsLink } from "./data/SettingsLinkContext";
import { WINDOW_LABEL } from "../engine/window";
import "./app-shell.css";

// Only the main window carries the global chats sidebar (docs/IMPLEMENTATION_PLAN.md Phase 5).
// Windows spawned by a tab tear-off are focused terminal UIs — their tab strip + artifacts panel
// only — so a chat lives in one obvious place instead of being duplicated across every window.
const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

// docs/REDESIGN_PLAN.md Phase R5/R6 — the main window's content area switches between these.
// "home" and "code" are reached via Titlebar's view switcher; "toolbox"/"docs" are reached via
// Sidebar's nav rows (still land back on "code" when the titlebar's Code tab is clicked). Secondary
// windows never leave "code" — they have no sidebar to navigate from and no Home concept.
export type MainView = "home" | "code" | "toolbox" | "docs";

export function AppShell() {
  // docs/MISSION_CONTROL_PLAN.md M1 — Mission Control's whole width/collapse/pane/rail state,
  // persisted per window. Owned here (not inside <MissionControl>) because Titlebar's toggle
  // button and the command palette's "toggle mission control" action both need to drive
  // `panelCollapsed` without a context.
  const geometry = useMissionControlGeometry();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<MainView>("code");
  // docs/REDESIGN_PLAN.md Phase R4 — one settings modal, opened from the sidebar footer (main
  // window), ⌘, / the ⌘K command palette (every window — see CommandPalette.tsx), or a P1 deep
  // link (ModelPicker's banner, StatusBar's dot) — SettingsLinkContext owns open/close + target
  // so none of those callers need to prop-drill through this component.
  const { isOpen: settingsOpen, target: settingsTarget, open: openSettings, close: closeSettings } = useSettingsLink();

  const bodyClass = ["rama-body", geometry.panelCollapsed ? "rama-body-panel-collapsed" : ""].filter(Boolean).join(" ");

  // docs/REDESIGN_PLAN.md Phase R2 — native macOS traffic lights are an OS overlay fixed at the
  // window's top-left corner regardless of DOM (tauri.conf.json: titleBarStyle "Overlay"). The
  // sidebar's own header reserves that inset when it's the thing occupying the top-left (main
  // window, sidebar expanded); otherwise the titlebar has to reserve it itself — either this
  // window never has a sidebar, or it does but it's currently collapsed out of the way.
  const reserveTrafficGapInTitlebar = !IS_MAIN_WINDOW || !sidebarOpen;

  return (
    <div className="rama-root" data-screen-label="rama app">
      <AgentTerminalBridge />
      <AgentWebBridge />
      <WallpaperStack />
      <div className="rama-frame">
        {IS_MAIN_WINDOW && (
          <Sidebar
            collapsed={!sidebarOpen}
            onToggleCollapse={() => setSidebarOpen((v) => !v)}
            onOpenSettings={() => openSettings()}
            view={view}
            onNavigate={setView}
          />
        )}
        <div className="rama-main">
          <Titlebar
            reserveTrafficGap={reserveTrafficGapInTitlebar}
            panelOpen={!geometry.panelCollapsed}
            onTogglePanel={geometry.togglePanelCollapsed}
            showViewTabs={IS_MAIN_WINDOW}
            showSidebarToggle={IS_MAIN_WINDOW && !sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            view={view}
          />

          {IS_MAIN_WINDOW && view === "home" && <HomePane onOpenChat={() => setView("code")} />}
          {IS_MAIN_WINDOW && view === "toolbox" && <ToolboxPage />}
          {IS_MAIN_WINDOW && view === "docs" && <DocsPage />}
          {(!IS_MAIN_WINDOW || view === "code") && (
            <div
              ref={geometry.bodyRef}
              className={bodyClass}
              data-dragging={geometry.dragging || undefined}
              style={{ "--mc-w": `${geometry.width}px` } as CSSProperties}
            >
              <ChatColumn />
              {!geometry.panelCollapsed && <MissionControl geometry={geometry} />}
            </div>
          )}

          <StatusBar />
        </div>
      </div>
      <CommandPalette
        onTogglePanel={geometry.togglePanelCollapsed}
        onOpenSettings={() => openSettings()}
        onSelectPane={geometry.setActivePaneId}
        onToggleRail={geometry.toggleRailCollapsed}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        initialPane={settingsTarget?.pane}
        focusProviderId={settingsTarget?.providerId}
      />
    </div>
  );
}
