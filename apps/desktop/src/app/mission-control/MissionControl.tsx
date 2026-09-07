import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { MISSION_CONTROL_PANES, type MissionControlPaneId } from "./panes";
import type { MissionControlGeometry } from "./useMissionControlGeometry";
import { Rail } from "./Rail";
import { Stage } from "./Stage";
import { Splitter } from "./Splitter";
import "./mission-control.css";

const NARROW_RAIL_MIN = 88;
const NARROW_RAIL_MAX_RATIO = 0.6;
const WIDE_RAIL_MIN = 160;
const WIDE_RAIL_MAX = 480;

// docs/MISSION_CONTROL_PLAN.md M1 — the whole layout, driven by one `useMissionControlGeometry()`
// instance owned by AppShell (so Titlebar's toggle button and this panel share the same
// panelCollapsed flag without a context). Renders one real pane (Artifacts) and two visible-but-
// disabled stubs (Terminal, Web) — see panes.ts.
export function MissionControl({ geometry }: { geometry: MissionControlGeometry }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);
  const [breadcrumbOpen, setBreadcrumbOpen] = useState(false);

  const activePane = MISSION_CONTROL_PANES.find((p) => p.id === geometry.activePaneId) ?? MISSION_CONTROL_PANES[0];
  const wide = geometry.axis === "side";
  const badge = activePane.useBadge();

  const flushMainDrag = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current !== null) geometry.updateDragWidth(pendingRef.current);
  }, [geometry]);

  // §4.7 — the main panel-vs-chat splitter is on Mission Control's own left edge, so its width is
  // the distance from the cursor to the window's right edge, not to this element's own bounds.
  const handleMainDrag = useCallback(
    (clientX: number) => {
      pendingRef.current = window.innerWidth - clientX;
      if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushMainDrag);
    },
    [flushMainDrag],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // A pane switch invalidates any open overlay sheet from the previous pane.
  useEffect(() => {
    setBreadcrumbOpen(false);
  }, [geometry.activePaneId]);

  // docs/MISSION_CONTROL_PLAN.md §7.2 — the artifact ↔ terminal bridge's other half; see
  // ArtifactsRail.tsx's jumpToTerminalPane for why this is a window event and not a prop.
  useEffect(() => {
    function onSelectPane(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (MISSION_CONTROL_PANES.some((p) => p.id === id)) geometry.setActivePaneId(id as MissionControlPaneId);
    }
    window.addEventListener("rama:mc-select-pane", onSelectPane);
    return () => window.removeEventListener("rama:mc-select-pane", onSelectPane);
  }, [geometry]);

  const handleRailWidthDrag = useCallback(
    (clientX: number) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      const w = clientX - rect.left;
      geometry.setRailSize(Math.min(Math.max(w, WIDE_RAIL_MIN), WIDE_RAIL_MAX));
    },
    [geometry],
  );

  const handleRailHeightDrag = useCallback(
    (clientY: number) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      const h = clientY - rect.top;
      geometry.setNarrowRailSize(Math.min(Math.max(h, NARROW_RAIL_MIN), rect.height * NARROW_RAIL_MAX_RATIO));
    },
    [geometry],
  );

  const StageBody = activePane.Stage;

  let body: ReactNode;
  if (!wide && geometry.railCollapsed) {
    // §4.3 — narrow/collapsed: one breadcrumb row; clicking it opens the list as a transient
    // overlay sheet over the stage rather than pushing the stage down.
    body = (
      <div className="rama-mc-body" data-axis="stacked" ref={bodyRef}>
        <button type="button" className="rama-mc-breadcrumb" onClick={() => setBreadcrumbOpen((v) => !v)}>
          <span>{breadcrumbOpen ? "⌄" : "›"}</span>
          <span>
            {activePane.label}
            {badge && badge.count > 0 ? ` · ${badge.count}` : ""}
          </span>
        </button>
        <div className="rama-mc-stage">
          <StageBody />
          {breadcrumbOpen && (
            <div className="rama-mc-overlay-sheet">
              <activePane.Rail collapsed={false} />
            </div>
          )}
        </div>
      </div>
    );
  } else if (!wide) {
    // §4.2 — narrow/expanded: rail stacked above the stage, its height drag-resizable.
    body = (
      <div className="rama-mc-body" data-axis="stacked" ref={bodyRef}>
        <div style={{ height: geometry.narrowRailSize, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Rail pane={activePane} wide={false} collapsed={false} />
        </div>
        <Splitter orientation="horizontal" ariaLabel="Resize rail height" onDrag={handleRailHeightDrag} />
        <Stage pane={activePane} />
      </div>
    );
  } else {
    // §4.4 / §4.5 — wide: rail beside the stage, sharing one 36px band; collapses to a 44px icon
    // strip rather than to nothing.
    body = (
      <div className="rama-mc-body" data-axis="side" ref={bodyRef}>
        <Rail pane={activePane} wide collapsed={geometry.railCollapsed} size={geometry.railSize} />
        {!geometry.railCollapsed && (
          <Splitter orientation="vertical" ariaLabel="Resize rail width" onDrag={handleRailWidthDrag} />
        )}
        <Stage pane={activePane} />
      </div>
    );
  }

  return (
    <div className="rama-mission-control" data-axis={geometry.axis}>
      <Splitter
        orientation="vertical"
        variant="edge"
        ariaLabel="Resize Mission Control"
        onDragStart={geometry.beginDrag}
        onDrag={handleMainDrag}
        onDragEnd={geometry.endDrag}
        onDoubleClick={geometry.handleDoubleClick}
      />

      <div className="rama-mc-header">
        <button
          type="button"
          className="rama-mc-collapse-btn"
          onClick={geometry.toggleRailCollapsed}
          title={geometry.railCollapsed ? "Expand rail" : "Collapse rail"}
        >
          {geometry.railCollapsed ? "›" : "‹"}
        </button>
        <div className="rama-mc-tabs">
          {MISSION_CONTROL_PANES.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className={`rama-mc-tab${pane.id === activePane.id ? " rama-mc-tab-active" : ""}`}
              disabled={pane.disabled}
              onClick={() => geometry.setActivePaneId(pane.id)}
              title={pane.label}
            >
              <pane.Icon />
              <span>{pane.label}</span>
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="rama-mc-overflow-btn"
          title={wide ? "Stack rail on top" : "Move rail to the side"}
          onClick={() => geometry.setAxisOverride(wide ? "stacked" : "side")}
        >
          ⋯
        </button>
      </div>

      {activePane.Provider ? <activePane.Provider>{body}</activePane.Provider> : body}
    </div>
  );
}
