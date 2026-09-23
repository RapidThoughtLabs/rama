// AGENT_BROWSER_PLAN.md AB1/AB2 — the lazy DOM bundle. Unlike hook.ts, this is *not* an
// `initialization_script`: it's only injected into a page on the first `browser snapshot` (or
// future `read`/action) call against it, guarded by `window.__ramaDomLoaded` so a second
// injection is a no-op. Every page pays hook.ts's <5KB; only pages an agent actually inspects pay
// this bundle's cost.
//
// Owns `window.__ramaSnapshot()`: runs walk.ts's pure walker against `document`, assigns refs
// into `window.__ramaRefs`, bumps `window.__ramaGen`, and returns the serialized §6.1 text.
// AB3 adds `window.__ramaRead()` (Readability → Turndown, see read.ts) and AB4 adds
// `window.__ramaAction()` (click/type/press/scroll, see actions.ts) — both lazy-loaded the same
// way the snapshot walker is, since none of this belongs in hook.ts's always-on <5KB budget.
//
// AB5 — every action now runs `window.__ramaSettle()` (hook.ts) after dispatching, then re-walks
// the page and diffs it against whatever the *previous* snapshot/action left behind (diff.ts),
// instead of the model needing to guess whether the page has caught up and take a fresh snapshot
// itself. `full: true` on an action op skips the diff and returns the whole new snapshot instead
// — see the ActionOp/ActionOutcome shapes below, which tools/browser.ts and AgentWebBridge.tsx
// both mirror.

import { serializeSnapshot, walkDocument, type WalkNode } from "./walk";
import { extractArticle } from "./read";
import { dispatchClick, dispatchPress, dispatchScroll, dispatchType, type ActionResult } from "./actions";
import { diffSnapshot } from "./diff";

export {};

type ActionOp =
  | { op: "click"; ref: number; full?: boolean }
  | { op: "type"; ref: number; text: string; submit?: boolean; full?: boolean }
  | { op: "press"; key: string; full?: boolean }
  | { op: "scroll"; to: "top" | "bottom" | number; full?: boolean };

// The settle+diff fields are only present on a successful dispatch (see __ramaAction below) —
// a failed/blocked dispatch returns the plain ActionResult shape unchanged, since nothing
// happened for there to be a diff of.
interface ActionOutcome extends ActionResult {
  settleReason?: string;
  settleMs?: number;
  genFrom?: number;
  genTo?: number;
  diff?: string[];
  full?: boolean;
  snapshot?: string;
  refCount?: number;
  console?: string[];
}

declare global {
  interface Window {
    __ramaDomLoaded?: boolean;
    __ramaRefs?: Map<number, Element>;
    __ramaGen?: number;
    __ramaSnapshot?: (depth?: "outline" | "full") => string;
    __ramaRead?: () => string;
    __ramaAction?: (opJson: string) => Promise<string>;
  }
}

(function installRamaDom() {
  if (window.__ramaDomLoaded) return;
  window.__ramaDomLoaded = true;

  window.__ramaGen = 0;

  // AB4 — which generation each ref number was last assigned at, so a stale ref can say *why* it's
  // stale (Decision 10's "generation gap", not just "not found"). Deliberately never cleared by
  // clearRefs — it only grows for the life of this JS realm (a real navigation tears the whole
  // realm down anyway, which is the only case that should reset it).
  const refGenOf = new Map<number, number>();

  // AB5 — what the *last* snapshot (explicit `__ramaSnapshot` call, or the last action's own
  // post-settle re-walk) looked like, so the next action has something to diff against. Deliberately
  // module-scoped like refGenOf, not returned to the caller — nothing outside this file needs the
  // raw WalkNode list, only the serialized text/diff derived from it.
  let lastSnapshotNodes: WalkNode[] = [];

  function clearRefs(): void {
    window.__ramaRefs = new Map();
    window.__ramaGen = (window.__ramaGen ?? 0) + 1;
  }
  clearRefs();

  // A stale ref must error, never silently re-resolve against a page that has since navigated —
  // AGENT_BROWSER_PLAN.md Decision 10. Clearing refs (not just bumping gen) makes that the only
  // possible outcome: the old numbers point at nothing.
  window.addEventListener("pagehide", clearRefs);
  window.addEventListener("popstate", clearRefs);

  // Shared by `__ramaSnapshot` and `__ramaAction`'s own post-settle re-walk, so ref assignment,
  // gen bumping, and the lastSnapshotNodes cache only ever happen in one place.
  function takeSnapshot(depth: "outline" | "full" = "outline"): { nodes: WalkNode[]; text: string; gen: number } {
    const nodes: WalkNode[] = walkDocument(document, { depth });
    clearRefs();
    const refs = window.__ramaRefs!;
    const gen = window.__ramaGen ?? 0;
    for (const node of nodes) {
      if (node.ref !== null && node.element) {
        refs.set(node.ref, node.element);
        refGenOf.set(node.ref, gen);
      }
    }
    lastSnapshotNodes = nodes;
    const text = serializeSnapshot(nodes, {
      pageId: "", // the page doesn't know its own Rama page id — the caller fills this in
      title: document.title || "",
      url: String(location.href),
      gen,
    });
    return { nodes, text, gen };
  }

  // Returns JSON, not the raw §6.1 text — `gen` and `refCount` are separate protocol fields
  // (`BrowserResponseBody`), and this way the caller (webview.rs's `webview_snapshot`) doesn't
  // need a second eval round trip just to learn what generation the refs it got back belong to.
  window.__ramaSnapshot = function (depth: "outline" | "full" = "outline"): string {
    const { text, gen } = takeSnapshot(depth);
    return JSON.stringify({ text, gen, refCount: window.__ramaRefs!.size });
  };

  // AGENT_BROWSER_PLAN.md AB3 §6.3 — Readability → Turndown, falling back to innerText. See
  // read.ts's own doc for why the fallback matters as much as the happy path.
  window.__ramaRead = function (): string {
    return JSON.stringify(extractArticle(document));
  };

  // AGENT_BROWSER_PLAN.md AB4 — resolves `ref` against the *current* `__ramaRefs`/`refGenOf`
  // (never re-resolving a stale one, Decision 10) and dispatches into actions.ts. `press` and
  // `scroll` don't take a ref at all — they act on the focused element / the document respectively.
  //
  // AB5 — on a successful dispatch, waits for `window.__ramaSettle()` (hook.ts) and then either
  // diffs the new snapshot against `lastSnapshotNodes` or, with `full: true`, returns the whole
  // new snapshot text instead. A blocked/failed dispatch (stale ref, covered element, ...) skips
  // all of this and returns immediately — nothing happened, so there's nothing to settle or diff.
  window.__ramaAction = async function (opJson: string): Promise<string> {
    let dispatch: ActionResult;
    let parsed: ActionOp | undefined;
    try {
      parsed = JSON.parse(opJson) as ActionOp;
      if (parsed.op === "press") {
        dispatch = dispatchPress(document, parsed.key);
      } else if (parsed.op === "scroll") {
        dispatch = dispatchScroll(document, parsed.to);
      } else {
        const refs = window.__ramaRefs;
        const gen = window.__ramaGen ?? 0;
        const el = refs?.get(parsed.ref);
        if (!el) {
          const originGen = refGenOf.get(parsed.ref);
          dispatch = {
            ok: false,
            error:
              originGen !== undefined
                ? `ref ${parsed.ref} is from snapshot gen ${originGen}; the page is at gen ${gen} — take a new snapshot`
                : `ref ${parsed.ref} was never assigned by a snapshot — take a snapshot first`,
          };
        } else if (!el.isConnected) {
          dispatch = { ok: false, error: `ref ${parsed.ref} no longer in the document` };
        } else if (parsed.op === "click") {
          dispatch = dispatchClick(el);
        } else {
          dispatch = dispatchType(el, parsed.text, parsed.submit);
        }
      }
    } catch (e) {
      return JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies ActionOutcome);
    }

    if (!dispatch.ok) return JSON.stringify(dispatch satisfies ActionOutcome);

    const startSeq = window.__ramaNextSeq ? window.__ramaNextSeq() - 1 : 0;
    const genFrom = window.__ramaGen ?? 0;
    const prevNodes = lastSnapshotNodes;

    const settledRaw = window.__ramaSettle ? await window.__ramaSettle() : JSON.stringify({ reason: "settle unavailable — hook.ts not loaded", ms: 0 });
    const settled = JSON.parse(settledRaw) as { reason: string; ms: number };

    const snap = takeSnapshot("outline");
    const consoleEntries = window.__ramaConsoleSince
      ? (JSON.parse(window.__ramaConsoleSince(startSeq)) as { level: string; text: string }[])
      : [];
    const consoleDelta = consoleEntries.map((e) => `${e.level}: ${e.text}`);

    const outcome: ActionOutcome = {
      ok: true,
      settleReason: settled.reason,
      settleMs: settled.ms,
      genFrom,
      genTo: snap.gen,
      console: consoleDelta,
    };
    if (parsed?.full) {
      outcome.full = true;
      outcome.snapshot = snap.text;
      outcome.refCount = window.__ramaRefs!.size;
    } else {
      outcome.diff = diffSnapshot(prevNodes, snap.nodes);
    }
    return JSON.stringify(outcome);
  };
})();
