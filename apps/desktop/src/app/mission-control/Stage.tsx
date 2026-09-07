import type { MissionControlPane } from "./panes";

// docs/MISSION_CONTROL_PLAN.md §4.1 — the stage side of the rail/stage split. Deliberately thin:
// unlike Rail.tsx, the toolbar band is pane-owned (a diff's filename + copy/open icons looks
// nothing like a terminal's cwd + kill button), so this just hosts `pane.Stage` in the flex
// column that gives it the matching 36px band via CSS, not shared markup.
export function Stage({ pane }: { pane: MissionControlPane }) {
  const StageBody = pane.Stage;
  return (
    <div className="rama-mc-stage">
      <StageBody />
    </div>
  );
}
