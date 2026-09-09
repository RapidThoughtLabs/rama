import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

// docs/MISSION_CONTROL_PLAN.md §4.7 — one splitter component for both drag handles: the
// panel-vs-chat edge (variant="edge", orientation="vertical") and the rail-vs-stage divider
// (variant="inline", orientation="vertical"). Pointer capture, not mousemove-on-window — the
// drag can't lose events if the cursor leaves the handle mid-gesture.
export function Splitter({
  orientation,
  variant = "inline",
  onDragStart,
  onDrag,
  onDragEnd,
  onDoubleClick,
  ariaLabel,
}: {
  orientation: "vertical" | "horizontal";
  variant?: "edge" | "inline";
  onDragStart?: () => void;
  onDrag: (clientPos: number) => void;
  onDragEnd?: () => void;
  onDoubleClick?: () => void;
  ariaLabel: string;
}) {
  const draggingRef = useRef(false);

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      onDragStart?.();
    },
    [onDragStart],
  );

  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onDrag(orientation === "vertical" ? e.clientX : e.clientY);
    },
    [onDrag, orientation],
  );

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      e.currentTarget.releasePointerCapture(e.pointerId);
      onDragEnd?.();
    },
    [onDragEnd],
  );

  return (
    <div
      className={`rama-mc-splitter rama-mc-splitter-${orientation} rama-mc-splitter-${variant}`}
      role="separator"
      aria-orientation={orientation}
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onDoubleClick={onDoubleClick}
    />
  );
}
