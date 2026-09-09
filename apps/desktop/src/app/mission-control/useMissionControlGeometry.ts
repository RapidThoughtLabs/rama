import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { WINDOW_LABEL } from "../../engine/window";
import type { MissionControlPaneId } from "./panes";

// docs/MISSION_CONTROL_PLAN.md §4.7 — all of Mission Control's view state (width, rail sizes,
// collapse, active pane, axis override) in one place, persisted per window. This is view state,
// not user data — it belongs in localStorage, not SQLite (§8, M1's own note).

const STORAGE_KEY = `rama:mission-control:${WINDOW_LABEL}`;
const DEFAULT_WIDTH = 384;
const MIN_WIDTH = 320;
const RIGHT_MARGIN = 480; // the chat column can never be crushed below this
const AXIS_BREAKPOINT = 600;
const SNAP_POINTS = [384, 600];
const SNAP_PULL = 16;
const DEFAULT_RAIL_SIZE = 260; // wide-mode rail width, px
const DEFAULT_NARROW_RAIL_SIZE = 160; // narrow-mode rail height, px

export type MissionControlAxis = "stacked" | "side";

interface PersistedGeometry {
  width: number;
  panelCollapsed: boolean;
  activePaneId: MissionControlPaneId;
  /** One shared collapse flag, not per-pane — a rail collapsed on the Artifacts tab should stay
   *  collapsed when you switch to Terminal, same as any other view-chrome preference. */
  railCollapsed: boolean;
  railSize: number;
  narrowRailSize: number;
  axisOverride: MissionControlAxis | null;
  lastWideWidth: number;
  lastNarrowWidth: number;
}

const DEFAULTS: PersistedGeometry = {
  width: DEFAULT_WIDTH,
  panelCollapsed: false,
  activePaneId: "artifacts",
  railCollapsed: false,
  railSize: DEFAULT_RAIL_SIZE,
  narrowRailSize: DEFAULT_NARROW_RAIL_SIZE,
  axisOverride: null,
  lastWideWidth: 720,
  lastNarrowWidth: DEFAULT_WIDTH,
};

function load(): PersistedGeometry {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return DEFAULTS;
  }
}

function save(patch: Partial<PersistedGeometry>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), ...patch }));
  } catch {
    // best-effort — view state only, never worth failing over
  }
}

export interface MissionControlGeometry {
  /** The whole panel's own show/hide — what Titlebar's IconPanel button and the palette's
   *  "toggle mission control" action drive. Distinct from `railCollapsed` below. */
  panelCollapsed: boolean;
  togglePanelCollapsed: () => void;
  /** Attach to `.rama-body` — drag writes `--mc-w` here directly, bypassing React (§4.7). */
  bodyRef: RefObject<HTMLDivElement | null>;
  width: number;
  dragging: boolean;
  axis: MissionControlAxis;
  setAxisOverride: (a: MissionControlAxis | null) => void;
  activePaneId: MissionControlPaneId;
  setActivePaneId: (id: MissionControlPaneId) => void;
  /** Rail-within-Mission-Control collapse — one flag shared across every pane (§4.5's icon strip
   *  / §4.3's breadcrumb), so collapsing it on one tab keeps it collapsed on the others. */
  railCollapsed: boolean;
  toggleRailCollapsed: () => void;
  railSize: number;
  setRailSize: (n: number) => void;
  narrowRailSize: number;
  setNarrowRailSize: (n: number) => void;
  beginDrag: () => void;
  updateDragWidth: (px: number) => void;
  endDrag: () => void;
  handleDoubleClick: () => void;
}

export function useMissionControlGeometry(): MissionControlGeometry {
  const initial = useRef(load()).current;
  const bodyRef = useRef<HTMLDivElement>(null);

  const [width, setWidthState] = useState(initial.width);
  const [panelCollapsed, setPanelCollapsed] = useState(initial.panelCollapsed);
  const [activePaneId, setActivePaneIdState] = useState<MissionControlPaneId>(initial.activePaneId);
  const [railCollapsed, setRailCollapsedState] = useState(initial.railCollapsed);
  const [railSize, setRailSizeState] = useState(initial.railSize);
  const [narrowRailSize, setNarrowRailSizeState] = useState(initial.narrowRailSize);
  const [axisOverride, setAxisOverrideState] = useState<MissionControlAxis | null>(initial.axisOverride);
  const [dragging, setDragging] = useState(false);

  const widthRef = useRef(width);
  const lastWideRef = useRef(initial.lastWideWidth);
  const lastNarrowRef = useRef(initial.lastNarrowWidth);

  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Resizing the OS window itself used to do nothing to `width` — it's only ever written by a
  // drag or a snap, so shrinking the window could leave the panel wider than `clamp()` would
  // allow, or straddling the axis breakpoint in a way that never got a chance to settle. That's
  // what "doesn't shift the sidebar fluently" was actually describing: the layout wasn't reacting
  // to the resize at all until the next manual drag. Debounced (not rAF-throttled like a drag —
  // this fires far less often and doesn't need to track the cursor) via a plain timeout.
  useEffect(() => {
    let timer: number | undefined;
    function onResize() {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const max = Math.max(MIN_WIDTH, window.innerWidth - RIGHT_MARGIN);
        const clamped = Math.min(Math.max(widthRef.current, MIN_WIDTH), max);
        if (clamped !== widthRef.current) {
          widthRef.current = clamped;
          setWidthState(clamped);
          save({ width: clamped });
        }
      }, 80);
    }
    window.addEventListener("resize", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const axis: MissionControlAxis = axisOverride ?? (width >= AXIS_BREAKPOINT ? "side" : "stacked");

  const togglePanelCollapsed = useCallback(() => {
    setPanelCollapsed((v) => {
      const next = !v;
      save({ panelCollapsed: next });
      return next;
    });
  }, []);

  const setActivePaneId = useCallback((id: MissionControlPaneId) => {
    setActivePaneIdState(id);
    save({ activePaneId: id });
  }, []);

  const toggleRailCollapsed = useCallback(() => {
    setRailCollapsedState((v) => {
      const next = !v;
      save({ railCollapsed: next });
      return next;
    });
  }, []);

  const setRailSize = useCallback((n: number) => {
    setRailSizeState(n);
    save({ railSize: n });
  }, []);

  const setNarrowRailSize = useCallback((n: number) => {
    setNarrowRailSizeState(n);
    save({ narrowRailSize: n });
  }, []);

  const setAxisOverride = useCallback((a: MissionControlAxis | null) => {
    setAxisOverrideState(a);
    save({ axisOverride: a });
  }, []);

  function clamp(px: number): number {
    const max = Math.max(MIN_WIDTH, window.innerWidth - RIGHT_MARGIN);
    return Math.min(Math.max(px, MIN_WIDTH), max);
  }

  function snap(px: number): number {
    const half = window.innerWidth / 2;
    for (const point of [...SNAP_POINTS, half]) {
      if (Math.abs(px - point) <= SNAP_PULL) return point;
    }
    return px;
  }

  const beginDrag = useCallback(() => setDragging(true), []);

  // §4.7 — write `--mc-w` directly on every pointermove (rAF-batched by the caller), never
  // React state per mousemove; the diff/preview panes would visibly chug otherwise.
  const updateDragWidth = useCallback((px: number) => {
    const clamped = clamp(snap(px));
    widthRef.current = clamped;
    bodyRef.current?.style.setProperty("--mc-w", `${clamped}px`);
  }, []);

  const endDrag = useCallback(() => {
    setDragging(false);
    const final = widthRef.current;
    setWidthState(final);
    if (final >= AXIS_BREAKPOINT) lastWideRef.current = final;
    else lastNarrowRef.current = final;
    save({ width: final, lastWideWidth: lastWideRef.current, lastNarrowWidth: lastNarrowRef.current });
  }, []);

  const handleDoubleClick = useCallback(() => {
    const isWide = widthRef.current >= AXIS_BREAKPOINT;
    const next = isWide ? lastNarrowRef.current : lastWideRef.current;
    widthRef.current = next;
    setWidthState(next);
    save({ width: next });
  }, []);

  return {
    panelCollapsed,
    togglePanelCollapsed,
    bodyRef,
    width,
    dragging,
    axis,
    setAxisOverride,
    activePaneId,
    setActivePaneId,
    railCollapsed,
    toggleRailCollapsed,
    railSize,
    setRailSize,
    narrowRailSize,
    setNarrowRailSize,
    beginDrag,
    updateDragWidth,
    endDrag,
    handleDoubleClick,
  };
}
