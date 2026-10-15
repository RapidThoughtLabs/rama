import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { WINDOW_LABEL } from "../../../engine/window";
import { requestOpenFile } from "../../mission-control/panes/openFileBridge";
import type { MissionControlPaneId } from "../../mission-control/panes";
import { parseGoto, stashGotoArg } from "./gotoBridge";

/* The workspace's view state — docs/CODE_REDESIGN_PLAN.md CR3. Replaces useMissionControlGeometry:
   open/closed, width, rail collapse and the active pane, persisted per window. View state, not
   user data, so localStorage rather than SQLite.

   Widths are px in `--ws-w` on `.r-code-body`; until the first drag the mockup's 48% applies
   (workspace.css), which is why `widthPx` is nullable. The rail is a fixed 212 or 48 — there is no
   rail-width drag any more. */

const STORAGE_KEY = `rama:workspace:${WINDOW_LABEL}`;
const LEGACY_KEY = `rama:mission-control:${WINDOW_LABEL}`;

export const SHEET_QUERY = "(max-width: 1100px)";
export const MIN_WS = 360; // mock:L513
const MIN_CHAT = 380; // mock:L2142
const SEAM = 12; // splitter width; also the workspace's right margin
const WIDE_FROM = 600; // double-click toggles across this width
const NARROW_DEFAULT = 420;
const WIDE_DEFAULT = 720;

interface Persisted {
  open: boolean | null; // null = never toggled, so the default for the window width applies
  widthPx: number | null;
  railCollapsed: boolean;
  pane: MissionControlPaneId;
  lastNarrow: number;
  lastWide: number;
}

const DEFAULTS: Persisted = {
  open: null,
  widthPx: null,
  railCollapsed: false,
  pane: "changes",
  lastNarrow: NARROW_DEFAULT,
  lastWide: WIDE_DEFAULT,
};

const PANE_IDS: readonly string[] = ["changes", "terminal", "web", "files"];

function load(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
    // One-time migration from Mission Control's key. Its px width was for a 384px-minimum panel
    // beside a different layout, so the width is dropped; collapse, rail and pane carry over.
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const old = JSON.parse(legacy) as { panelCollapsed?: boolean; railCollapsed?: boolean; activePaneId?: string };
      const migrated: Persisted = {
        ...DEFAULTS,
        open: old.panelCollapsed === undefined ? null : !old.panelCollapsed,
        railCollapsed: !!old.railCollapsed,
        pane: PANE_IDS.includes(old.activePaneId ?? "") ? (old.activePaneId as MissionControlPaneId) : "changes",
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      localStorage.removeItem(LEGACY_KEY);
      return migrated;
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULTS;
}

function save(patch: Partial<Persisted>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...load(), ...patch }));
  } catch {
    // best-effort — view state only
  }
}

export function useIsSheet(): boolean {
  const [sheet, setSheet] = useState(() => window.matchMedia(SHEET_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(SHEET_QUERY);
    const on = () => setSheet(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return sheet;
}

export interface WorkspaceGeometry {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  pane: MissionControlPaneId;
  setPane: (id: MissionControlPaneId) => void;
  railCollapsed: boolean;
  toggleRail: () => void;
  /** Below 1100px the workspace is a sheet over the chat (mock:L605-608). */
  sheet: boolean;
  /** `.r-code-body` — drag writes `--ws-w` here directly, bypassing React. */
  bodyRef: RefObject<HTMLDivElement | null>;
  widthPx: number | null;
  dragging: boolean;
  beginDrag: () => void;
  dragTo: (clientX: number) => void;
  endDrag: () => void;
  resetWidth: () => void;
  /** Keyboard resize: grows the workspace by `delta` px (negative shrinks), within the same clamp as a drag. */
  nudgeWidth: (delta: number) => void;
  /** Select a pane, apply its arg, and open the workspace: `goto("changes:src/a.ts")`. */
  goto: (spec: string) => void;
}

export function useWorkspaceGeometry(): WorkspaceGeometry {
  const initial = useRef(load()).current;
  const sheet = useIsSheet();
  const bodyRef = useRef<HTMLDivElement>(null);

  // `open: null` means "never toggled": open on a wide window, closed on a narrow one (mock:L2157).
  const [open, setOpenState] = useState<boolean>(initial.open ?? !window.matchMedia(SHEET_QUERY).matches);
  const [pane, setPaneState] = useState<MissionControlPaneId>(initial.pane);
  const [railCollapsed, setRailCollapsed] = useState(initial.railCollapsed);
  const [widthPx, setWidthPx] = useState<number | null>(initial.widthPx);
  const [dragging, setDragging] = useState(false);

  const widthRef = useRef<number | null>(initial.widthPx);
  const lastNarrow = useRef(initial.lastNarrow);
  const lastWide = useRef(initial.lastWide);
  const rafRef = useRef<number | null>(null);
  const pendingX = useRef<number | null>(null);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    save({ open: next });
  }, []);
  const toggleOpen = useCallback(() => {
    setOpenState((v) => {
      save({ open: !v });
      return !v;
    });
  }, []);
  const setPane = useCallback((id: MissionControlPaneId) => {
    setPaneState(id);
    save({ pane: id });
  }, []);
  const toggleRail = useCallback(() => {
    setRailCollapsed((v) => {
      save({ railCollapsed: !v });
      return !v;
    });
  }, []);

  const clamp = useCallback((px: number): number => {
    const bodyW = bodyRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    return Math.round(Math.min(Math.max(px, MIN_WS), Math.max(MIN_WS, bodyW - MIN_CHAT)));
  }, []);

  const applyWidth = useCallback((px: number) => {
    widthRef.current = px;
    bodyRef.current?.style.setProperty("--ws-w", `${px}px`);
  }, []);

  const beginDrag = useCallback(() => setDragging(true), []);

  // mock:L2143-2148, rAF-batched: width = distance from the cursor to the body's right edge, less
  // the workspace's own margin. Written straight to the DOM; React learns the final value on drop.
  const dragTo = useCallback(
    (clientX: number) => {
      pendingX.current = clientX;
      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        const body = bodyRef.current;
        if (!body || pendingX.current === null) return;
        applyWidth(clamp(body.getBoundingClientRect().right - pendingX.current - SEAM));
      });
    },
    [applyWidth, clamp],
  );

  const endDrag = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setDragging(false);
    const w = widthRef.current;
    if (w === null) return;
    setWidthPx(w);
    if (w >= WIDE_FROM) lastWide.current = w;
    else lastNarrow.current = w;
    save({ widthPx: w, lastNarrow: lastNarrow.current, lastWide: lastWide.current });
  }, []);

  // Double-click flips between the last narrow and last wide width.
  const resetWidth = useCallback(() => {
    const current = widthRef.current ?? bodyRef.current?.querySelector(".r-ws")?.getBoundingClientRect().width ?? 0;
    const next = clamp(current >= WIDE_FROM ? lastNarrow.current : lastWide.current);
    applyWidth(next);
    setWidthPx(next);
    save({ widthPx: next });
  }, [applyWidth, clamp]);

  const nudgeWidth = useCallback(
    (delta: number) => {
      const current = widthRef.current ?? bodyRef.current?.querySelector(".r-ws")?.getBoundingClientRect().width ?? 0;
      const next = clamp(current + delta);
      applyWidth(next);
      setWidthPx(next);
      if (next >= WIDE_FROM) lastWide.current = next;
      else lastNarrow.current = next;
      save({ widthPx: next, lastNarrow: lastNarrow.current, lastWide: lastWide.current });
    },
    [applyWidth, clamp],
  );

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  const goto = useCallback(
    (spec: string) => {
      const target = parseGoto(spec);
      if (!target) return;
      setPane(target.pane);
      if (target.pane === "files") {
        if (target.arg) requestOpenFile(target.arg);
      } else {
        stashGotoArg(target);
      }
      setOpen(true);
    },
    [setPane, setOpen],
  );

  // The old cross-pane events keep working as aliases of goto (plan CR3): `rama:open-file` from a
  // chat path pill, `rama:mc-select-pane` from the artifacts rail, `rama:mc-expand-rail`.
  useEffect(() => {
    function onOpenFile(e: Event) {
      const path = (e as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      setPane("files");
      setOpen(true);
    }
    function onSelectPane(e: Event) {
      const id = (e as CustomEvent<string>).detail;
      if (!PANE_IDS.includes(id)) return;
      setPane(id as MissionControlPaneId);
      setOpen(true);
    }
    function onExpandRail() {
      setRailCollapsed((v) => {
        if (!v) return v;
        save({ railCollapsed: false });
        return false;
      });
    }
    window.addEventListener("rama:open-file", onOpenFile);
    window.addEventListener("rama:mc-select-pane", onSelectPane);
    window.addEventListener("rama:mc-expand-rail", onExpandRail);
    return () => {
      window.removeEventListener("rama:open-file", onOpenFile);
      window.removeEventListener("rama:mc-select-pane", onSelectPane);
      window.removeEventListener("rama:mc-expand-rail", onExpandRail);
    };
  }, [setPane, setOpen]);

  return {
    open,
    setOpen,
    toggleOpen,
    pane,
    setPane,
    railCollapsed,
    toggleRail,
    sheet,
    bodyRef,
    widthPx,
    dragging,
    beginDrag,
    dragTo,
    endDrag,
    resetWidth,
    nudgeWidth,
    goto,
  };
}
