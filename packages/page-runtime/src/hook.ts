// AGENT_BROWSER_PLAN.md AB1 — the always-on init script, replacing webview.rs's old
// CONSOLE_HOOK_SCRIPT (a 200-entry console ring and nothing else). Bundled by scripts/build.ts
// into a standalone IIFE and shipped as `dist/hook.iife.js`, injected via Tauri's
// `initialization_script` on every page a Rama window opens — including ones the user browsed to
// themselves, not just agent-driven ones. That's the hard rule this file lives under: **no
// exception this script causes may ever escape into the host page.** Everything is wrapped, and
// nothing outside the `window.__rama*` namespace is touched or reassigned except `console.*`,
// `window.fetch`, and `XMLHttpRequest.prototype.open`/`.send` — all three restored to behave
// identically for the host page's own code, just observed in passing.
//
// Kept deliberately small (<5KB minified, asserted in test/hook.test.ts) since every page pays
// this cost; the a11y walker, Readability, and Turndown all live in dom.ts instead, loaded lazily
// only for pages an agent actually inspects.

export {};

interface ConsoleEntry {
  seq: number;
  level: "log" | "warn" | "error" | "info";
  text: string;
  ts: number;
}

interface NetworkEntry {
  seq: number;
  method: string;
  url: string;
  status: number | null;
  ok: boolean;
  ms: number;
  ts: number;
}

declare global {
  interface Window {
    __ramaHooked?: boolean;
    __ramaConsole?: ConsoleEntry[];
    __ramaNetwork?: NetworkEntry[];
    __ramaInFlight?: number;
    __ramaLastMutationAt?: number;
    __ramaNextSeq?: () => number;
    __ramaConsoleSince?: (since?: number, limit?: number) => string;
    __ramaSettle?: (timeoutMs?: number) => Promise<string>;
  }
}

(function installRamaHook() {
  if (window.__ramaHooked) return;
  window.__ramaHooked = true;

  const CONSOLE_LIMIT = 200;
  const NETWORK_LIMIT = 100;

  let seq = 0;
  const nextSeq = () => ++seq;
  window.__ramaNextSeq = nextSeq;

  const consoleLog: ConsoleEntry[] = [];
  const networkLog: NetworkEntry[] = [];
  window.__ramaConsole = consoleLog;
  window.__ramaNetwork = networkLog;
  window.__ramaInFlight = 0;
  window.__ramaLastMutationAt = Date.now();

  function safe(fn: () => void): void {
    try {
      fn();
    } catch {
      // Bookkeeping must never throw into the host page — see the module doc's hard rule.
    }
  }

  function pushConsole(level: ConsoleEntry["level"], args: unknown[]): void {
    safe(() => {
      const text = Array.prototype.map
        .call(args, (a) => {
          try {
            return typeof a === "string" ? a : JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");
      consoleLog.push({ seq: nextSeq(), level, text, ts: Date.now() });
      if (consoleLog.length > CONSOLE_LIMIT) consoleLog.shift();
    });
  }

  (["log", "warn", "error", "info"] as const).forEach((level) => {
    const orig = console[level];
    console[level] = function (this: Console, ...args: unknown[]) {
      pushConsole(level, args);
      return orig.apply(this, args);
    };
  });

  // An uncaught exception never reaches console.error, and is exactly the failure a test loop
  // must not miss silently. Neither listener calls preventDefault — the browser's own error
  // reporting (devtools, onerror chaining) is left exactly as it would have been.
  window.addEventListener("error", (event: ErrorEvent) => {
    safe(() => pushConsole("error", [event.message || "Error", `at ${event.filename}:${event.lineno}:${event.colno}`]));
  });
  window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
    safe(() => pushConsole("error", ["Unhandled promise rejection:", event.reason]));
  });

  function pushNetwork(entry: Omit<NetworkEntry, "seq">): void {
    safe(() => {
      networkLog.push({ seq: nextSeq(), ...entry });
      if (networkLog.length > NETWORK_LIMIT) networkLog.shift();
    });
  }

  function trackStart(): number {
    window.__ramaInFlight = (window.__ramaInFlight || 0) + 1;
    return Date.now();
  }
  function trackEnd(): void {
    window.__ramaInFlight = Math.max(0, (window.__ramaInFlight || 1) - 1);
  }

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    // Cast: newer `lib.dom.d.ts` adds a `preconnect` static to `typeof fetch` that no wrapper
    // function value can satisfy structurally — this wrapper still behaves identically to a real
    // `fetch` for every call site, it just isn't assignable to that (unused) extra property.
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const method = (init?.method || (input instanceof Request ? input.method : undefined) || "GET").toUpperCase();
      const url = input instanceof Request ? input.url : String(input);
      const start = trackStart();
      return origFetch.call(window, input, init).then(
        (res) => {
          trackEnd();
          pushNetwork({ method, url, status: res.status, ok: res.ok, ms: Date.now() - start, ts: start });
          return res;
        },
        (err) => {
          trackEnd();
          pushNetwork({ method, url, status: null, ok: false, ms: Date.now() - start, ts: start });
          throw err;
        },
      );
    } as typeof fetch;
  }

  // Prototype patching rather than replacing the `XMLHttpRequest` constructor — simpler, and
  // every existing instance-creation call site (`new XMLHttpRequest()`) keeps working unmodified.
  const xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (xhrProto) {
    const origOpen = xhrProto.open;
    const origSend = xhrProto.send;
    type TrackedXhr = XMLHttpRequest & { __ramaMethod?: string; __ramaUrl?: string };

    xhrProto.open = function (this: TrackedXhr, method: string, url: string | URL, ...rest: unknown[]) {
      this.__ramaMethod = String(method).toUpperCase();
      this.__ramaUrl = String(url);
      // @ts-expect-error — passthrough to whichever native `open` overload the caller used
      return origOpen.call(this, method, url, ...rest);
    };

    xhrProto.send = function (this: TrackedXhr, ...args: unknown[]) {
      const start = trackStart();
      const finish = () => {
        trackEnd();
        pushNetwork({
          method: this.__ramaMethod || "GET",
          url: this.__ramaUrl || "",
          status: this.status || null,
          ok: this.status >= 200 && this.status < 400,
          ms: Date.now() - start,
          ts: start,
        });
      };
      this.addEventListener("loadend", finish, { once: true });
      // @ts-expect-error — passthrough
      return origSend.call(this, ...args);
    };
  }

  // AGENT_BROWSER_PLAN.md AB3 — `console`'s v2 read path: entries since a given seq (so a test
  // loop can ask "what happened since my last action" instead of re-reading the whole ring every
  // time), merged with failed network requests, sorted chronologically. When the combined set is
  // larger than `limit`, errors/warnings are kept over plain logs rather than whichever entries
  // happen to be newest — a 100-entry cap full of debug noise must not push out the one
  // TypeError a test loop actually needs to see.
  window.__ramaConsoleSince = function (since?: number, limit = 100): string {
    const sinceSeq = since ?? 0;
    const combined: { seq: number; level: string; text: string }[] = [];
    for (const e of consoleLog) {
      if (e.seq > sinceSeq) combined.push({ seq: e.seq, level: e.level, text: e.text });
    }
    for (const e of networkLog) {
      if (e.seq > sinceSeq && !e.ok) {
        combined.push({ seq: e.seq, level: "error", text: `network: ${e.method} ${e.url} → ${e.status ?? "failed"} (${e.ms}ms)` });
      }
    }
    combined.sort((a, b) => a.seq - b.seq);

    let out = combined;
    if (combined.length > limit) {
      const rank = (level: string) => (level === "error" || level === "warn" ? 0 : 1);
      out = combined
        .slice()
        .sort((a, b) => rank(a.level) - rank(b.level) || a.seq - b.seq)
        .slice(0, limit)
        .sort((a, b) => a.seq - b.seq);
    }
    return JSON.stringify(out);
  };

  // AGENT_BROWSER_PLAN.md AB5 — the determinism layer, living here (not dom.ts) because it only
  // reads state this always-on hook already tracks (`__ramaInFlight`, `__ramaLastMutationAt`),
  // so callers that just want to wait for a page to go quiet (`open`, `reload`, the action ops)
  // never need dom.ts's much heavier a11y-walker bundle injected first. Resolves once nothing is
  // in flight *and* the DOM has been quiet for SETTLE_QUIET_MS, or gives up at the timeout —
  // either way it returns *why* it stopped, since "timed out, 2 requests still in flight" and
  // "settled cleanly" mean very different things to whoever asked.
  const SETTLE_POLL_MS = 100;
  const SETTLE_QUIET_MS = 300;
  const SETTLE_DEFAULT_MS = 5_000;
  const SETTLE_MAX_MS = 30_000;

  window.__ramaSettle = function (timeoutMs: number = SETTLE_DEFAULT_MS): Promise<string> {
    const cap = Math.min(Math.max(timeoutMs, 0), SETTLE_MAX_MS);
    const start = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        const inFlight = window.__ramaInFlight ?? 0;
        const quietFor = Date.now() - (window.__ramaLastMutationAt ?? start);
        const elapsed = Date.now() - start;
        if (inFlight === 0 && quietFor > SETTLE_QUIET_MS) {
          resolve(JSON.stringify({ reason: "network idle, dom stable", ms: elapsed }));
          return;
        }
        if (elapsed >= cap) {
          const secs = cap % 1000 === 0 ? String(cap / 1000) : (cap / 1000).toFixed(1);
          const why: string[] = [];
          if (inFlight > 0) why.push(`${inFlight} request${inFlight === 1 ? "" : "s"} still in flight`);
          if (quietFor <= SETTLE_QUIET_MS) why.push("dom still mutating");
          resolve(JSON.stringify({ reason: `timed out after ${secs}s${why.length ? ` (${why.join(", ")})` : ""}`, ms: elapsed }));
          return;
        }
        setTimeout(tick, SETTLE_POLL_MS);
      };
      tick();
    });
  };

  safe(() => {
    const observer = new MutationObserver(() => {
      window.__ramaLastMutationAt = Date.now();
    });
    const start = () => {
      if (document.documentElement) {
        observer.observe(document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  });
})();
