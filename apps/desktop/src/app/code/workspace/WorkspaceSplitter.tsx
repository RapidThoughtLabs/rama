import { useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import { MIN_WS } from "./useWorkspaceGeometry";

/* The 12px seam between chat and workspace (mock:L509-512, 2139-2150). Pointer capture, so a drag
   can't lose events when the cursor leaves the strip. The grip pill is CSS only. Focusable: ←/→ move
   the seam by 24px (plan CR9 §3), so the workspace grows on ← and shrinks on →. */
const KEY_STEP = 24;

export function WorkspaceSplitter({
  dragging,
  onDragStart,
  onDrag,
  onDragEnd,
  onDoubleClick,
  onNudge,
  width,
}: {
  dragging: boolean;
  onDragStart: () => void;
  onDrag: (clientX: number) => void;
  onDragEnd: () => void;
  onDoubleClick: () => void;
  onNudge: (delta: number) => void;
  /** The workspace's width in px once it has been set, for assistive tech. */
  width: number | null;
}) {
  const active = useRef(false);

  function down(e: ReactPointerEvent<HTMLDivElement>) {
    e.preventDefault();
    active.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    onDragStart();
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    if (active.current) onDrag(e.clientX);
  }
  function up(e: ReactPointerEvent<HTMLDivElement>) {
    if (!active.current) return;
    active.current = false;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onDragEnd();
  }

  function key(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowLeft") onNudge(KEY_STEP);
    else if (e.key === "ArrowRight") onNudge(-KEY_STEP);
    else if (e.key === "Enter") onDoubleClick();
    else return;
    e.preventDefault();
  }

  return (
    <div
      className={dragging ? "r-splitter drag" : "r-splitter"}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace"
      aria-valuemin={MIN_WS}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      onKeyDown={key}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onDoubleClick}
    />
  );
}
