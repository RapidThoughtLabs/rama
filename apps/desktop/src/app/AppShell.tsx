import { MainWall } from "@rama/ui";
import { Seal } from "./shell/Seal";
import { Sidebar } from "./shell/Sidebar";
import { Topbar } from "./shell/Topbar";
import { CodeTopbar } from "./code/CodeTopbar";
import { CodeBody } from "./code/workspace/CodeBody";
import { WorkspaceProvider, useWorkspace } from "./code/workspace/WorkspaceContext";
import { CodeChat } from "./code/CodeChat";
import { CommandPalette } from "./CommandPalette";
import { DocsPage } from "./DocsPage";
import { HomeTopbar, HomeView } from "./home/HomeView";
import { AgentTerminalBridge } from "./mission-control/AgentTerminalBridge";
import { AgentWebBridge } from "./mission-control/AgentWebBridge";
import { SettingsModal } from "./SettingsModal";
import { ToolboxPage } from "./ToolboxPage";
import { useNavigation } from "./data/NavigationProvider";
import { useSettingsLink } from "./data/SettingsLinkContext";
import { WINDOW_LABEL } from "../engine/window";
import "./app-shell.css";
import "./shell/shell.css";

// Only the main window carries the global chats sidebar (docs/IMPLEMENTATION_PLAN.md Phase 5).
// Windows spawned by a tab tear-off are focused terminal UIs — their tab strip + artifacts panel
// only — so a chat lives in one obvious place instead of being duplicated across every window.
const IS_MAIN_WINDOW = WINDOW_LABEL === "main";

// What the main area shows lives in NavigationProvider (HOME_REDESIGN_PLAN.md Phase HD1).
export type { MainView } from "./data/NavigationProvider";

export function AppShell() {
  return (
    <WorkspaceProvider>
      <AppShellBody />
    </WorkspaceProvider>
  );
}

function AppShellBody() {
  // docs/CODE_REDESIGN_PLAN.md CR3 — the workspace's open/width/rail/pane state lives in
  // WorkspaceProvider (above this component) because the top bar's toggle and the command
  // palette both drive it from outside the code view.
  const ws = useWorkspace();
  const nav = useNavigation();
  const view = IS_MAIN_WINDOW ? nav.view : "code";

  // docs/REDESIGN_PLAN.md Phase R4 — one settings modal, opened from the sidebar footer (main
  // window), ⌘, / the ⌘K command palette (every window — see CommandPalette.tsx), or a P1 deep
  // link (the composer's model menu, the topbar) — SettingsLinkContext owns open/close + target
  // so none of those callers need to prop-drill through this component.
  const { isOpen: settingsOpen, target: settingsTarget, open: openSettings, close: closeSettings } = useSettingsLink();

  // HOME_REDESIGN_PLAN.md Phase HD1 — the mockup's shell (mock:L96-199): `.r-app` holds the
  // sidebar and `.r-main`, which carries the wallpaper, the top bar, the seal and the active view.
  // Screens not yet restyled render as `.r-legacy` islands inside `.r-view`. The palette and the
  // settings modal stay outside `.r-app` — they're position: fixed and still legacy-styled.
  return (
    <>
      <div
        className="r-app"
        data-screen-label="rama app"
        data-sb={IS_MAIN_WINDOW && nav.sidebarOpen ? "open" : "closed"}
        data-window={IS_MAIN_WINDOW ? "main" : "secondary"}
      >
        <AgentTerminalBridge />
        <AgentWebBridge />
        {IS_MAIN_WINDOW && <Sidebar onOpenSettings={() => openSettings()} />}
        <main className="r-main">
          <MainWall />
          <Topbar>
            {view === "code" && <CodeTopbar />}
            {view === "home" && <HomeTopbar />}
          </Topbar>
          <Seal />

          {view === "home" && <HomeView />}
          {view === "toolbox" && (
            <section className="r-view r-legacy">
              <ToolboxPage />
            </section>
          )}
          {view === "docs" && (
            <section className="r-view r-legacy">
              <DocsPage />
            </section>
          )}
          {view === "code" && (
            <section className="r-view r-view-code">
              <CodeBody>
                <CodeChat />
              </CodeBody>
            </section>
          )}
        </main>
      </div>
      <CommandPalette
        onTogglePanel={ws.toggleOpen}
        onOpenSettings={() => openSettings()}
        onSelectPane={(id) => ws.goto(id)}
        onToggleRail={ws.toggleRail}
      />
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        initialPane={settingsTarget?.pane}
        focusProviderId={settingsTarget?.providerId}
      />
    </>
  );
}
