import { useState } from "react";
import { WallpaperStack } from "@rama/ui";
import { Titlebar } from "./Titlebar";
import { Sidebar } from "./Sidebar";
import { ChatColumn } from "./ChatColumn";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { StatusBar } from "./StatusBar";
import { WINDOW_LABEL } from "../engine/window";
import "./app-shell.css";

// Only the main window carries the global chats sidebar (docs/IMPLEMENTATION_PLAN.md Phase 5).
// Windows spawned by a tab tear-off are focused terminal UIs — their tab strip + artifacts panel
// only — so a chat lives in one obvious place instead of being duplicated across every window.
const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

export function AppShell() {
  const [panelOpen, setPanelOpen] = useState(true);

  const bodyClass = [
    "rama-body",
    panelOpen ? "" : "rama-body-panel-collapsed",
    IS_MAIN_WINDOW ? "" : "rama-body-no-sidebar",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="rama-root" data-screen-label="rama app">
      <WallpaperStack />
      <div className="rama-frame">
        <Titlebar panelOpen={panelOpen} onTogglePanel={() => setPanelOpen((v) => !v)} />

        <div className={bodyClass}>
          {IS_MAIN_WINDOW && <Sidebar />}
          <ChatColumn />
          {panelOpen && <ArtifactsPanel />}
        </div>

        <StatusBar />
      </div>
    </div>
  );
}
