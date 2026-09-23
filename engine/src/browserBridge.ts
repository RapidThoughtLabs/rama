// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the engine-side half of the `browser` tool's
// request/response round trip. Same root cause as bash.ts's `background` path and process.ts's
// `kill` (§7.1/§7.3): this is a headless Bun process with no way to call a Tauri command, so it
// can only broadcast `browser.request` on the project WS topic (tools/browser.ts) and wait. Only
// the frontend (AgentWebBridge.tsx) can actually create/eval a webview; it POSTs the result to
// `POST /browser/:requestId/response` (server.ts), which resolves the matching promise here.
//
// Unlike terminal.*, this doesn't need its own SessionEvent for the response leg — the result
// only ever needs to reach this one Bun process, not every open window, so a plain HTTP POST is
// enough; there's nothing here for a live client to render.

export interface BrowserResponseBody {
  ok: boolean;
  pageId?: string;
  title?: string;
  url?: string;
  text?: string;
  consoleLogs?: string[];
  error?: string;
  // AGENT_BROWSER_PLAN.md AB2 — `snapshot`'s payload: the serialized §6.1 text, the ref
  // generation it was assigned at, and how many refs it produced.
  snapshot?: string;
  gen?: number;
  refCount?: number;
  // AGENT_BROWSER_PLAN.md AB3 — `read`'s extraction path (see read.ts), and `console`'s newest
  // seq, so the tool can tell the model what to pass as `since` next time.
  readMode?: "readability" | "innerText";
  readFallbackReason?: string;
  lastSeq?: number;
  // AGENT_BROWSER_PLAN.md AB5 — action ops' settle+diff payload. `diff` is absent when `full` is
  // set, in which case the whole new snapshot rides the existing `snapshot`/`gen`/`refCount`
  // fields above instead (the same shape the `snapshot` op returns). `consoleLogs` doubles for
  // an action's own console/network delta since its start seq, same "level: text" shape as
  // `console`'s.
  settleReason?: string;
  settleMs?: number;
  genFrom?: number;
  diff?: string[];
  full?: boolean;
  // AGENT_BROWSER_PLAN.md AB0 Decision 11 — which window actually answered, so the next request
  // for this project can be addressed to it instead of broadcasting to every window.
  windowLabel?: string;
}

const pending = new Map<string, (body: BrowserResponseBody) => void>();
const pendingProject = new Map<string, string>();
// AB0 Decision 11 — last window that successfully answered a request for a given project.
// tools/browser.ts reads this to address the next `browser.request` at a specific window rather
// than broadcasting to all of them; see getResponderWindow.
const lastResponderWindow = new Map<string, string>();
// AGENT_BROWSER_PLAN.md AB4 — the engine's own approximation of "the agent's most recent page"
// and "what origin is it on", built purely from response traffic it already sees (no new round
// trip). Actions need this *before* they run, to gate loopback-vs-ask (permissions.ts's
// resolveBrowserActionRule) without waiting on the frontend's own page resolution. See Risk 3 in
// the plan doc — this is an approximation of per-window page state, not a fix for it.
const lastPageId = new Map<string, string>(); // projectId -> pageId
const pageOrigin = new Map<string, string>(); // pageId -> origin

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function getResponderWindow(projectId: string): string | undefined {
  return lastResponderWindow.get(projectId);
}

export function getLastPageId(projectId: string): string | undefined {
  return lastPageId.get(projectId);
}

export function getPageOrigin(pageId: string): string | undefined {
  return pageOrigin.get(pageId);
}

export function waitForBrowserResponse(requestId: string, timeoutMs: number, projectId?: string): Promise<BrowserResponseBody> {
  if (projectId) pendingProject.set(requestId, projectId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        pendingProject.delete(requestId);
        resolve({ ok: false, error: "timed out waiting for a Rama window to respond — is one open?" });
      }
    }, timeoutMs);
    pending.set(requestId, (body) => {
      clearTimeout(timer);
      resolve(body);
    });
  });
}

// AB0 Decision 11, replacing the old "first response in wins, no memory of who" rule: every open
// window's AgentWebBridge still reacts to a broadcast it wasn't the elected responder for (the
// bootstrap case, and the 2s-no-answer fallback re-broadcast — see tools/browser.ts), but a
// late/duplicate POST from a second window is accepted (so it doesn't error client-side) and
// silently dropped here. A response carrying `windowLabel` updates the election for next time.
export function resolveBrowserResponse(requestId: string, body: BrowserResponseBody): boolean {
  const resolver = pending.get(requestId);
  const projectId = pendingProject.get(requestId);
  pendingProject.delete(requestId);
  if (!resolver) return false;
  pending.delete(requestId);
  if (projectId && body.windowLabel) lastResponderWindow.set(projectId, body.windowLabel);
  if (projectId && body.pageId) lastPageId.set(projectId, body.pageId);
  if (body.pageId && body.url) {
    const origin = originOf(body.url);
    if (origin) pageOrigin.set(body.pageId, origin);
  }
  resolver(body);
  return true;
}
