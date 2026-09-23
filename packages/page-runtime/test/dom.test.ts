// AGENT_BROWSER_PLAN.md AB2/AB3/AB4/AB5 — integration tests over the *built* `dist/hook.iife.js` +
// `dist/dom.iife.js` (not the TS source), the same "exercise exactly what gets injected" approach
// hook.test.ts uses for the always-on hook. walk.ts/read.ts/actions.ts/diff.ts each have their own
// source-level unit tests; this file is specifically about the wiring dom.ts owns on top of them:
// ref assignment, the stale-ref / generation-mismatch errors (Decision 10), `__ramaRead`/
// `__ramaAction` existing and doing the right thing end to end, and — AB5 — that actions actually
// settle before diffing.
//
// Both bundles are loaded onto the same `window`, in the order webview.rs uses them for real: HOOK_SRC
// is a real init script (always present before any of this runs), DOM_SCRIPT is re-sent ahead of
// every snapshot/read/action eval. That's what makes `window.__ramaSettle` (hook.ts) available to
// `__ramaAction` (dom.ts) here the same way it is in production, instead of dom.ts needing its own
// defensive fallback path exercised only by this test file.
//
// Bundle-size budget lives here too (AB1's <120KB line) rather than in a new file, since AB3
// pulled Readability+Turndown into this same bundle and it's the one already asserting a budget.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const HOOK_SRC = readFileSync(new URL("../dist/hook.iife.js", import.meta.url), "utf8");
const DOM_SRC = readFileSync(new URL("../dist/dom.iife.js", import.meta.url), "utf8");
const MAX_DOM_BYTES = 120 * 1024;

function installDom(html: string, opts: { beforeHook?: (win: Record<string, any>) => void } = {}) {
  const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
  win.document.write(`<html><body>${html}</body></html>`);
  opts.beforeHook?.(win);
  const runHook = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
  runHook(win, win.document, win.console, win.MutationObserver, win.Request);
  const runDom = new Function("window", "document", "location", DOM_SRC);
  runDom(win, win.document, win.location);
  return win;
}

function stubRect(el: Record<string, any>) {
  el.getBoundingClientRect = () => ({ x: 0, y: 0, width: 50, height: 20, top: 0, left: 0, right: 50, bottom: 20 });
}

function snapshot(win: Record<string, any>, depth: "outline" | "full" = "outline") {
  return JSON.parse(win.__ramaSnapshot(depth)) as { text: string; gen: number; refCount: number };
}

async function act(win: Record<string, any>, op: unknown) {
  return JSON.parse(await win.__ramaAction(JSON.stringify(op))) as {
    ok: boolean;
    error?: string;
    warning?: string;
    settleReason?: string;
    settleMs?: number;
    genFrom?: number;
    genTo?: number;
    diff?: string[];
    full?: boolean;
    snapshot?: string;
    refCount?: number;
    console?: string[];
  };
}

describe("AB1/AB3 rama-dom bundle size", () => {
  test("dist/dom.iife.js stays under the 120KB budget even with Readability + Turndown", () => {
    expect(DOM_SRC.length).toBeLessThan(MAX_DOM_BYTES);
  });
});

describe("AB2 __ramaSnapshot wiring", () => {
  test("assigns refs in document order and bumps gen on every call", () => {
    const win = installDom('<button id="a">A</button><button id="b">B</button>');
    const s1 = snapshot(win);
    expect(s1.refCount).toBe(2);
    const s2 = snapshot(win);
    expect(s2.gen).toBeGreaterThan(s1.gen);
  });
});

describe("AB3 __ramaRead wiring", () => {
  test("returns JSON with a mode field, not just raw text", () => {
    const win = installDom("<p>short</p>");
    const result = JSON.parse(win.__ramaRead());
    expect(result.mode).toBe("innerText");
    expect(typeof result.markdown).toBe("string");
  });
});

describe("AB4 __ramaAction wiring — Decision 10, stale refs", () => {
  test("a ref number never assigned by any snapshot is rejected", async () => {
    const win = installDom('<button id="a">A</button>');
    snapshot(win);
    const result = await act(win, { op: "click", ref: 999 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("never assigned");
  });

  test("a ref from an earlier generation names the gap, not just 'not found'", async () => {
    const win = installDom('<button id="a">A</button><button id="b">B</button>');
    const s1 = snapshot(win);
    win.document.getElementById("b").remove();
    const s2 = snapshot(win);
    expect(s2.refCount).toBe(1);

    const result = await act(win, { op: "click", ref: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain(`gen ${s1.gen}`);
    expect(result.error).toContain(`gen ${s2.gen}`);
    expect(result.error).toContain("take a new snapshot");
  });

  test("an element detached after its own snapshot (no re-snapshot taken) is reported as detached, not gen-stale", async () => {
    const win = installDom('<button id="a">A</button>');
    snapshot(win);
    win.document.getElementById("a").remove();
    const result = await act(win, { op: "click", ref: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no longer in the document");
  });

  test("type dispatches through actions.ts and rejects a malformed op payload without throwing", async () => {
    const win = installDom('<input id="i"/>');
    snapshot(win);
    const ok = await act(win, { op: "type", ref: 1, text: "hello" });
    expect(ok.ok).toBe(true);
    expect(win.document.getElementById("i").value).toBe("hello");

    const bad = JSON.parse(await win.__ramaAction("not json"));
    expect(bad.ok).toBe(false);
    expect(typeof bad.error).toBe("string");
  });
});

describe("AB5 __ramaAction — settle + diff", () => {
  test("click dispatches through actions.ts, settles, and reports no changes for an inert button", async () => {
    const win = installDom('<button id="a">A</button>');
    snapshot(win);
    const btn = win.document.getElementById("a");
    stubRect(btn);
    win.document.elementFromPoint = () => btn;
    let clicked = false;
    btn.addEventListener("click", () => (clicked = true));

    const result = await act(win, { op: "click", ref: 1 });
    expect(result.ok).toBe(true);
    expect(clicked).toBe(true);
    expect(result.settleReason).toBe("network idle, dom stable");
    expect(result.genTo).toBeGreaterThan(result.genFrom!);
    expect(result.diff).toEqual([]);
  });

  test("press and scroll don't need a ref, and still settle+diff", async () => {
    const win = installDom('<input id="i"/>');
    win.document.getElementById("i").focus();
    const pressResult = await act(win, { op: "press", key: "Escape" });
    expect(pressResult.ok).toBe(true);
    expect(pressResult.settleReason).toBe("network idle, dom stable");

    const scrollResult = await act(win, { op: "scroll", to: "top" });
    expect(scrollResult.ok).toBe(true);
    expect(scrollResult.settleReason).toBe("network idle, dom stable");
  });

  test("a blocked click (covered element) skips settle entirely — no settleReason on failure", async () => {
    const win = installDom('<button id="a">A</button><div id="overlay">wait</div>');
    snapshot(win);
    const btn = win.document.getElementById("a");
    stubRect(btn);
    win.document.elementFromPoint = () => win.document.getElementById("overlay");

    const result = await act(win, { op: "click", ref: 1 });
    expect(result.ok).toBe(false);
    expect(result.settleReason).toBeUndefined();
  });

  test("a click that adds new elements reports them as + lines in the diff", async () => {
    const win = installDom('<button id="load">Load</button><div id="out"></div>');
    const btn = win.document.getElementById("load");
    stubRect(btn);
    win.document.elementFromPoint = () => btn;
    btn.addEventListener("click", () => {
      win.document.getElementById("out").innerHTML = '<button id="result">Loaded</button>';
    });

    snapshot(win);
    const result = await act(win, { op: "click", ref: 1 });
    expect(result.ok).toBe(true);
    expect(result.diff!.some((l) => l.includes("+") && l.includes("Loaded"))).toBe(true);
  });

  test("full: true returns the whole new snapshot instead of a diff", async () => {
    const win = installDom('<button id="a">A</button>');
    snapshot(win);
    const btn = win.document.getElementById("a");
    stubRect(btn);
    win.document.elementFromPoint = () => btn;

    const result = await act(win, { op: "click", ref: 1, full: true });
    expect(result.ok).toBe(true);
    expect(result.full).toBe(true);
    expect(result.diff).toBeUndefined();
    expect(typeof result.snapshot).toBe("string");
    expect(result.refCount).toBeGreaterThanOrEqual(1);
  });

  // The regression AB5 exists to prevent: click a button whose handler kicks off a fetch and only
  // renders once it resolves — reading (or diffing) immediately after dispatch would see the old,
  // pre-fetch page. `__ramaAction` must wait for hook.ts's own in-flight tracking to go quiet
  // before diffing, so the returned diff reflects the *rendered* content, not the stale page.
  test("click → 400ms delayed fetch-then-render: the diff contains the rendered content, not the stale page", async () => {
    let resolveFetch!: () => void;
    const win = installDom('<button id="load">Load</button><div id="out"></div>', {
      beforeHook: (w) => {
        w.fetch = () =>
          new Promise((resolve) => {
            resolveFetch = () => resolve({ status: 200, ok: true });
          });
      },
    });
    const btn = win.document.getElementById("load");
    stubRect(btn);
    win.document.elementFromPoint = () => btn;
    btn.addEventListener("click", () => {
      win.fetch("/api/recommend").then(() => {
        win.document.getElementById("out").innerHTML =
          '<button id="result">Rick Astley - Never Gonna Give You Up</button>';
      });
    });

    const before = snapshot(win);
    expect(before.refCount).toBe(1);
    setTimeout(() => resolveFetch(), 400);

    const result = await act(win, { op: "click", ref: 1 });
    expect(result.ok).toBe(true);
    expect(result.settleReason).toBe("network idle, dom stable");
    expect(result.diff!.some((l) => l.includes("Rick Astley"))).toBe(true);
  });
});
