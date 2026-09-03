import { useState } from "react";
import { WallpaperStack } from "@rama/ui";
import { Titlebar } from "./Titlebar";
import { Sidebar } from "./Sidebar";
import { ChatColumn } from "./ChatColumn";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { CommandPalette } from "./CommandPalette";
import { DocsPage } from "./DocsPage";
import { HomePane } from "./HomePane";
import { SettingsModal } from "./SettingsModal";
import { StatusBar } from "./StatusBar";
import { ToolboxPage } from "./ToolboxPage";
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
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [view, setView] = useState<MainView>("code");
  // docs/REDESIGN_PLAN.md Phase R4 — one settings modal, opened from the sidebar footer (main
  // window) or ⌘, / the ⌘K command palette (every window — see CommandPalette.tsx), so the
  // open/close state is lifted here rather than owned by either.
  const [settingsOpen, setSettingsOpen] = useState(false);

  const bodyClass = ["rama-body", panelOpen ? "" : "rama-body-panel-collapsed"].filter(Boolean).join(" ");

  // docs/REDESIGN_PLAN.md Phase R2 — native macOS traffic lights are an OS overlay fixed at the
  // window's top-left corner regardless of DOM (tauri.conf.json: titleBarStyle "Overlay"). The
  // sidebar's own header reserves that inset when it's the thing occupying the top-left (main
  // window, sidebar expanded); otherwise the titlebar has to reserve it itself — either this
  // window never has a sidebar, or it does but it's currently collapsed out of the way.
  const reserveTrafficGapInTitlebar = !IS_MAIN_WINDOW || !sidebarOpen;

  return (
    <div className="rama-root" data-screen-label="rama app">
      <WallpaperStack />
      <div className="rama-frame">
        {IS_MAIN_WINDOW && (
          <Sidebar
            collapsed={!sidebarOpen}
            onToggleCollapse={() => setSidebarOpen((v) => !v)}
            onOpenSettings={() => setSettingsOpen(true)}
            view={view}
            onNavigate={setView}
          />
        )}
        <div className="rama-main">
          <Titlebar
            reserveTrafficGap={reserveTrafficGapInTitlebar}
            panelOpen={panelOpen}
            onTogglePanel={() => setPanelOpen((v) => !v)}
            showViewTabs={IS_MAIN_WINDOW}
            showSidebarToggle={IS_MAIN_WINDOW && !sidebarOpen}
            onToggleSidebar={() => setSidebarOpen((v) => !v)}
            view={view}
          />

          {IS_MAIN_WINDOW && view === "home" && <HomePane onOpenChat={() => setView("code")} />}
          {IS_MAIN_WINDOW && view === "toolbox" && <ToolboxPage />}
          {IS_MAIN_WINDOW && view === "docs" && <DocsPage />}
          {(!IS_MAIN_WINDOW || view === "code") && (
            <div className={bodyClass}>
              <ChatColumn />
              {panelOpen && <ArtifactsPanel />}
            </div>
          )}

          <StatusBar />
        </div>
      </div>
      <CommandPalette onTogglePanel={() => setPanelOpen((v) => !v)} onOpenSettings={() => setSettingsOpen(true)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
