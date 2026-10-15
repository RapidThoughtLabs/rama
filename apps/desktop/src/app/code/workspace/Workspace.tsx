import { Icon } from "@rama/ui";
import { MISSION_CONTROL_PANES } from "../../mission-control/panes";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceTabs } from "./WorkspaceTabs";
import "./workspace.css";
import "./panes.css";

/* The workspace frame — docs/CODE_REDESIGN_PLAN.md CR3 + CR4 (mock:L513-547, 814-820, 1749-1812).
   A paper panel beside the chat: tab row across the top, then a 42px band row (the pane's stage
   bar, then its rail head), then the stage (content) and the rail (index) side by side. Each pane
   supplies four pieces — StageBar, RailHead, Stage, Rail — and this frame places them in the grid,
   so the band row's border is one line across both. The collapse toggle is the frame's, not the
   pane's: every rail head ends with it. */

export function Workspace() {
  const ws = useWorkspace();
  const pane = MISSION_CONTROL_PANES.find((p) => p.id === ws.pane) ?? MISSION_CONTROL_PANES[0]!;
  const Provider = pane.Provider;
  const collapsed = ws.railCollapsed;

  // Pane providers (changes, terminal, …) only live while their pane is active, as before. The
  // tab row sits outside them, so it never remounts on a tab switch.
  const panel = (
    <>
      <div className="r-stage-bar">
        <pane.StageBar />
      </div>
      <div className="r-rail-head">
        <pane.RailHead />
        <button
          className="r-icon-btn rail-toggle"
          onClick={ws.toggleRail}
          title={collapsed ? "Expand list" : "Collapse list"}
          aria-label="Toggle list"
        >
          <Icon name="panel-r" />
        </button>
      </div>
      <div className="r-stage">
        <pane.Stage />
      </div>
      <div className="r-rail">
        <pane.Rail collapsed={collapsed} />
      </div>
    </>
  );

  return (
    <aside className="r-ws" aria-label="Workspace" data-rail={collapsed ? "collapsed" : "open"}>
      <WorkspaceTabs pane={ws.pane} onSelect={ws.setPane} />
      {Provider ? <Provider key={pane.id}>{panel}</Provider> : panel}
    </aside>
  );
}
