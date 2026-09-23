// AGENT_BROWSER_PLAN.md AB1 acceptance criteria: bundle-size budget, an uncaught exception
// reporting through `__ramaConsole`, and "a page that never loads `rama-dom` behaves
// byte-identically to one without Rama" — tested here as "hook.ts alone never defines any
// `__ramaSnapshot`-shaped API; that's dom.ts's job and dom.ts is never loaded in this file".
//
// Runs the *built* `dist/hook.iife.js` (not the TS source) against a happy-dom `Window`, so this
// is exercising exactly what gets injected into a real webview, not just the pre-bundle logic.
// The IIFE references a handful of bare globals (`window`, `document`, `console`,
// `MutationObserver`, `Request`) that Bun's own runtime doesn't define — they're supplied as
// `Function` parameters bound to happy-dom's simulated versions, which is what lets a script
// written for a real browser run unmodified inside a `bun test` process with no real webview.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

const HOOK_SRC = readFileSync(new URL("../dist/hook.iife.js", import.meta.url), "utf8");
const MAX_HOOK_BYTES = 5 * 1024;

function runHook() {
  const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
  const calls: Record<"log" | "warn" | "error" | "info", unknown[][]> = { log: [], warn: [], error: [], info: [] };
  // The hook wraps whichever `console` object it's given — happy-dom's `win.console` is a
  // separate object from this one, so assertions must go through this reference, not `win.console`.
  const fakeConsole = {
    log: (...a: unknown[]) => calls.log.push(a),
    warn: (...a: unknown[]) => calls.warn.push(a),
    error: (...a: unknown[]) => calls.error.push(a),
    info: (...a: unknown[]) => calls.info.push(a),
  };
  const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
  run(win, win.document, fakeConsole, win.MutationObserver, win.Request);
  return { win, calls, console: fakeConsole };
}

describe("AB1 rama-hook", () => {
  test("dist/hook.iife.js stays under the 5KB budget", () => {
    expect(HOOK_SRC.length).toBeLessThan(MAX_HOOK_BYTES);
  });

  test("wraps console methods, forwards the call, and records it", () => {
    const { win, calls, console } = runHook();
    console.log("hello", 42);
    expect(calls.log).toEqual([["hello", 42]]);
    expect(win.__ramaConsole).toHaveLength(1);
    expect(win.__ramaConsole[0]).toMatchObject({ level: "log", text: "hello 42" });
  });

  test("an uncaught error reaches __ramaConsole even though it never called console.error", () => {
    const { win } = runHook();
    const ErrorEventCtor = win.ErrorEvent as new (type: string, init: object) => Event;
    win.dispatchEvent(new ErrorEventCtor("error", { message: "boom", filename: "app.js", lineno: 12, colno: 3 }));
    expect(win.__ramaConsole).toHaveLength(1);
    expect(win.__ramaConsole[0].level).toBe("error");
    expect(win.__ramaConsole[0].text).toContain("boom");
  });

  test("an unhandled promise rejection reaches __ramaConsole", () => {
    // happy-dom has no PromiseRejectionEvent constructor — a plain Event with a `reason`
    // property attached is exactly what the real one looks like from an event-listener's side.
    const { win } = runHook();
    const event = new win.Event("unhandledrejection") as Event & { reason?: unknown };
    event.reason = "network down";
    win.dispatchEvent(event);
    expect(win.__ramaConsole).toHaveLength(1);
    expect(win.__ramaConsole[0].text).toContain("network down");
  });

  test("fetch is wrapped: in-flight count rises then falls, and a network entry is recorded", async () => {
    // Stubs `window.fetch` with a fake *before* running the hook — it reads `window.fetch` once
    // at install time (`let y = window.fetch`), so this is what lets the test assert on network
    // bookkeeping without making a real request.
    const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
    win.fetch = async () => ({ status: 204, ok: true });
    const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
    run(win, win.document, { log() {}, warn() {}, error() {}, info() {} }, win.MutationObserver, win.Request);

    expect(win.__ramaInFlight).toBe(0);
    const pending = win.fetch("/api/thing");
    expect(win.__ramaInFlight).toBe(1);
    await pending;
    expect(win.__ramaInFlight).toBe(0);
    expect(win.__ramaNetwork).toHaveLength(1);
    expect(win.__ramaNetwork[0]).toMatchObject({ method: "GET", url: "/api/thing", status: 204, ok: true });
  });

  test("mutation tracking updates lastMutationAt", async () => {
    const { win } = runHook();
    const before = win.__ramaLastMutationAt;
    await new Promise((r) => setTimeout(r, 5));
    win.document.body.appendChild(win.document.createElement("div"));
    // MutationObserver callbacks are microtask-scheduled — give it a tick.
    await new Promise((r) => setTimeout(r, 10));
    expect(win.__ramaLastMutationAt).toBeGreaterThanOrEqual(before);
  });

  test("installing twice is a no-op (idempotent __ramaHooked guard)", () => {
    const { win } = runHook();
    const firstConsole = win.__ramaConsole;
    const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
    run(win, win.document, win.console, win.MutationObserver, win.Request);
    expect(win.__ramaConsole).toBe(firstConsole);
  });

  test("hook.ts alone never defines a snapshot API — that's dom.ts's, loaded separately", () => {
    const { win } = runHook();
    expect(win.__ramaSnapshot).toBeUndefined();
    expect(win.__ramaDomLoaded).toBeUndefined();
  });
});

describe("AB3 __ramaConsoleSince", () => {
  test("filters to entries after the given seq", () => {
    const { win, console } = runHook();
    console.log("first");
    console.log("second");
    const afterFirst = win.__ramaConsole[0].seq;
    const entries = JSON.parse(win.__ramaConsoleSince(afterFirst));
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe("second");
  });

  test("since defaults to 0 — everything so far comes back", () => {
    const { win, console } = runHook();
    console.log("a");
    console.warn("b");
    const entries = JSON.parse(win.__ramaConsoleSince());
    expect(entries).toHaveLength(2);
  });

  test("failed network requests are merged in, successful ones are not", async () => {
    const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
    let call = 0;
    win.fetch = async () => (call++ === 0 ? { status: 200, ok: true } : Promise.reject(new Error("boom")));
    const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
    run(win, win.document, { log() {}, warn() {}, error() {}, info() {} }, win.MutationObserver, win.Request);

    await win.fetch("/ok").catch(() => {});
    await win.fetch("/fails").catch(() => {});

    const entries = JSON.parse(win.__ramaConsoleSince());
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain("/fails");
    expect(entries[0].level).toBe("error");
  });

  test("when truncating to the limit, errors/warnings survive over plain logs", () => {
    const { win, console } = runHook();
    for (let i = 0; i < 5; i++) console.log(`noise ${i}`);
    console.error("the one that matters");
    for (let i = 0; i < 5; i++) console.log(`more noise ${i}`);

    const entries = JSON.parse(win.__ramaConsoleSince(0, 3));
    expect(entries).toHaveLength(3);
    expect(entries.some((e: { text: string }) => e.text === "the one that matters")).toBe(true);
  });

  test("truncated output stays in chronological order despite the severity-first selection pass", () => {
    const { win, console } = runHook();
    console.error("early error");
    for (let i = 0; i < 5; i++) console.log(`noise ${i}`);
    console.error("late error");

    const entries = JSON.parse(win.__ramaConsoleSince(0, 3));
    const seqs = entries.map((e: { seq: number }) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(entries[0].text).toBe("early error");
    expect(entries[entries.length - 1].text).toBe("late error");
  });
});

describe("AB5 __ramaSettle", () => {
  test("resolves 'network idle, dom stable' once nothing is in flight and the dom has been quiet", async () => {
    const { win } = runHook();
    const result = JSON.parse(await win.__ramaSettle(2000)) as { reason: string; ms: number };
    expect(result.reason).toBe("network idle, dom stable");
    expect(result.ms).toBeGreaterThan(0);
  });

  test("waits out in-flight requests before resolving", async () => {
    const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
    let resolveFetch!: () => void;
    win.fetch = () => new Promise((resolve) => (resolveFetch = () => resolve({ status: 200, ok: true })));
    const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
    run(win, win.document, { log() {}, warn() {}, error() {}, info() {} }, win.MutationObserver, win.Request);

    const pending = win.fetch("/slow");
    let settled = false;
    const settlePromise = win.__ramaSettle(2000).then((raw: string) => {
      settled = true;
      return JSON.parse(raw) as { reason: string };
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false); // still in flight — must not have resolved yet
    resolveFetch();
    await pending;
    const result = await settlePromise;
    expect(result.reason).toBe("network idle, dom stable");
  });

  test("times out and says why, without throwing", async () => {
    const win = new Window({ url: "https://example.com/" }) as unknown as Record<string, any>;
    win.fetch = () => new Promise(() => {}); // never resolves — always in flight
    const run = new Function("window", "document", "console", "MutationObserver", "Request", HOOK_SRC);
    run(win, win.document, { log() {}, warn() {}, error() {}, info() {} }, win.MutationObserver, win.Request);

    void win.fetch("/hangs");
    const result = JSON.parse(await win.__ramaSettle(500)) as { reason: string; ms: number };
    expect(result.reason).toContain("timed out after 0.5s");
    expect(result.reason).toContain("1 request still in flight");
    expect(result.ms).toBeGreaterThanOrEqual(500);
  });
});
