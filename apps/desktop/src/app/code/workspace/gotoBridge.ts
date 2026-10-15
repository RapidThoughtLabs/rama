import { useEffect, useRef } from "react";
import type { MissionControlPaneId } from "../../mission-control/panes";

/* The workspace's `goto(pane:arg)` — docs/CODE_REDESIGN_PLAN.md CR3 (mock:L1830-1840). One address
   for "show this thing in the workspace": `changes:<path>`, `terminal:<id>`, `web:<pageId>`,
   `files:<path>`. WorkspaceProvider.goto() selects the pane and opens the panel; the `arg` half
   lands here.

   Pane providers only mount while their pane is the active one, so a goto that switches panes
   fires before the provider that wants the arg exists. The arg is therefore stashed per pane and
   each provider claims it with useGotoArg() — on mount, and again whenever the event fires while
   it is already alive (same trick as openFileBridge.ts, which `files:` still goes through). */

export interface GotoTarget {
  pane: MissionControlPaneId;
  arg: string | null;
}

const PANES = new Set<string>(["changes", "terminal", "web", "files"]);
const EVENT = "rama:workspace-goto";
const pending = new Map<MissionControlPaneId, string>();

export function parseGoto(spec: string): GotoTarget | null {
  const i = spec.indexOf(":");
  const pane = i < 0 ? spec : spec.slice(0, i);
  if (!PANES.has(pane)) return null;
  const arg = i < 0 ? "" : spec.slice(i + 1);
  return { pane: pane as MissionControlPaneId, arg: arg || null };
}

export function stashGotoArg(target: GotoTarget): void {
  if (!target.arg) return;
  pending.set(target.pane, target.arg);
  window.dispatchEvent(new CustomEvent<GotoTarget>(EVENT, { detail: target }));
}

/** Claim a goto arg for `pane`. `ids` is the pane's loaded selectable ids; once the wanted one is
 *  among them `select` is called with it, once. Declare this hook after the provider's own
 *  "pick a default" effect so the explicit choice wins the batch. */
export function useGotoArg(pane: MissionControlPaneId, ids: readonly string[], select: (id: string) => void): void {
  const wanted = useRef<string | null>(pending.get(pane) ?? null);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const selectRef = useRef(select);
  selectRef.current = select;

  const apply = useRef(() => {
    if (wanted.current && idsRef.current.includes(wanted.current)) {
      selectRef.current(wanted.current);
      wanted.current = null;
    }
  }).current;

  useEffect(() => {
    pending.delete(pane);
    function onGoto(e: Event) {
      const t = (e as CustomEvent<GotoTarget>).detail;
      if (t.pane !== pane || !t.arg) return;
      wanted.current = t.arg;
      pending.delete(pane);
      apply();
    }
    window.addEventListener(EVENT, onGoto);
    return () => window.removeEventListener(EVENT, onGoto);
  }, [pane, apply]);

  useEffect(apply, [ids, apply]);
}
