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
}

const pending = new Map<string, (body: BrowserResponseBody) => void>();

export function waitForBrowserResponse(requestId: string, timeoutMs: number): Promise<BrowserResponseBody> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.delete(requestId)) {
        resolve({ ok: false, error: "timed out waiting for a Rama window to respond — is one open?" });
      }
    }, timeoutMs);
    pending.set(requestId, (body) => {
      clearTimeout(timer);
      resolve(body);
    });
  });
}

// §9 Risk 3's "only the focused window issues pty_resize" rule, applied here too: every open
// window's AgentWebBridge reacts to the same broadcast, but only one should actually act on it.
// First response in wins; a late/duplicate POST from another window is accepted (so it doesn't
// error client-side) and silently dropped.
export function resolveBrowserResponse(requestId: string, body: BrowserResponseBody): boolean {
  const resolver = pending.get(requestId);
  if (!resolver) return false;
  pending.delete(requestId);
  resolver(body);
  return true;
}
