import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { MISSION_CONTROL_PANES, type MissionControlPaneId } from "./panes";
import type { MissionControlGeometry } from "./useMissionControlGeometry";
import { Rail } from "./Rail";
import { Stage } from "./Stage";
import { Splitter } from "./Splitter";
import "./mission-control.css";

const WIDE_RAIL_MIN = 160;
const WIDE_RAIL_MAX = 480;

// docs/MISSION_CONTROL_PLAN.md M1 — the whole layout, driven by one `useMissionControlGeometry()`
// instance owned by AppShell. Renders one real pane (Artifacts) and two visible-but-disabled
// stubs (Terminal, Web) — see panes.ts. The pane switcher is a vertical tile strip stuck to the
// panel's own right edge (the window's right edge) and never collapses — it doubles as the
// panel's own open/close control: clicking the active pane's tile closes the panel (collapsing
// away the stage+rail body, not the tabstrip itself); clicking any tile re-opens it on that pane.
// That's also why there's no separate "toggle Mission Control" button in the titlebar anymore.
// Body order is stage-then-rail (not rail-then-stage): the rail is a secondary index onto the
// stage's content, so it sits in the middle, between the content it indexes and the tabstrip
// that switches panes — the stage itself gets the outermost (leftmost) slot.
export function MissionControl({ geometry }: { geometry: MissionControlGeometry }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<number | null>(null);

  const activePane = MISSION_CONTROL_PANES.find((p) => p.id === geometry.activePaneId) ?? MISSION_CONTROL_PANES[0];

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

  // docs/MISSION_CONTROL_PLAN.md §7.2 — the artifact ↔ terminal bridge's other half; see
  // ArtifactsRail.tsx's jumpToTerminalPane for why this is a window event and not a prop.
  useEffect(() => {
    function onSelectPane(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (!MISSION_CONTROL_PANES.some((p) => p.id === id)) return;
      geometry.setActivePaneId(id as MissionControlPaneId);
      if (geometry.panelCollapsed) geometry.togglePanelCollapsed();
    }
    function onExpandRail() {
      if (geometry.railCollapsed) geometry.toggleRailCollapsed();
    }
    window.addEventListener("rama:mc-select-pane", onSelectPane);
    window.addEventListener("rama:mc-expand-rail", onExpandRail);
    return () => {
      window.removeEventListener("rama:mc-select-pane", onSelectPane);
      window.removeEventListener("rama:mc-expand-rail", onExpandRail);
    };
  }, [geometry]);

  const handleRailWidthDrag = useCallback(
    (clientX: number) => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (!rect) return;
      // The rail is the body's right-hand column now (Stage · splitter · Rail), so its width is
      // the distance from the cursor to the body's *right* edge, not its left.
      const w = rect.right - clientX;
      geometry.setRailSize(Math.min(Math.max(w, WIDE_RAIL_MIN), WIDE_RAIL_MAX));
    },
    [geometry],
  );

  const body: ReactNode = (
    <div className="rama-mc-body" ref={bodyRef}>
      <Stage pane={activePane} />
      {!geometry.railCollapsed && (
        <Splitter orientation="vertical" ariaLabel="Resize rail width" onDrag={handleRailWidthDrag} />
      )}
      <Rail pane={activePane} collapsed={geometry.railCollapsed} size={geometry.railSize} />
    </div>
  );

  // A tile click either switches panes or opens/closes the panel — never both confusingly: only
  // the *already-active* pane's tile closes it (a plain toggle), so switching panes never has the
  // side effect of collapsing what you just opened.
  function handleTabClick(paneId: MissionControlPaneId) {
    if (paneId === activePane.id && !geometry.panelCollapsed) {
      geometry.togglePanelCollapsed();
      return;
    }
    geometry.setActivePaneId(paneId);
    if (geometry.panelCollapsed) geometry.togglePanelCollapsed();
  }

  return (
    <div className="rama-mission-control">
      {!geometry.panelCollapsed && (
        <>
          <Splitter
            orientation="vertical"
            variant="edge"
            ariaLabel="Resize Mission Control"
            onDragStart={geometry.beginDrag}
            onDrag={handleMainDrag}
            onDragEnd={geometry.endDrag}
            onDoubleClick={geometry.handleDoubleClick}
          />
          {activePane.Provider ? <activePane.Provider>{body}</activePane.Provider> : body}
        </>
      )}

      <div className="rama-mc-tabstrip">
        <button
          type="button"
          className="rama-mc-tab-tile rama-mc-collapse-tile"
          onClick={geometry.toggleRailCollapsed}
          title={geometry.railCollapsed ? "Expand rail" : "Collapse rail"}
        >
          {geometry.railCollapsed ? "‹" : "›"}
        </button>
        {MISSION_CONTROL_PANES.map((pane) => (
          <button
            key={pane.id}
            type="button"
            className={`rama-mc-tab-tile${
              pane.id === activePane.id && !geometry.panelCollapsed ? " rama-mc-tab-tile-active" : ""
            }`}
            disabled={pane.disabled}
            onClick={() => handleTabClick(pane.id)}
            title={pane.label}
          >
            <pane.Icon />
          </button>
        ))}
      </div>
    </div>
  );
}
