import type { CSSProperties, ReactNode } from "react";
import { Workspace } from "./Workspace";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceSplitter } from "./WorkspaceSplitter";

/* `.code-body` (mock:L375, 797-820): the flex row holding chat · splitter · workspace. The chat
   column is passed in so this file doesn't know about it. Closed hides the workspace and the
   splitter; below 1100px the workspace is a sheet over the chat and there is no splitter. */
export function CodeBody({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  return (
    <div
      ref={ws.bodyRef}
      className="r-code-body"
      data-ws={ws.open ? "open" : "closed"}
      data-sheet={ws.sheet || undefined}
      data-dragging={ws.dragging || undefined}
      style={ws.widthPx !== null ? ({ "--ws-w": `${ws.widthPx}px` } as CSSProperties) : undefined}
    >
      <div className="r-code-chat">{children}</div>
      {!ws.sheet && (
        <WorkspaceSplitter dragging={ws.dragging} onDragStart={ws.beginDrag} onDrag={ws.dragTo} onDragEnd={ws.endDrag} onDoubleClick={ws.resetWidth} onNudge={ws.nudgeWidth} width={ws.widthPx} />
      )}
      <Workspace />
    </div>
  );
}
