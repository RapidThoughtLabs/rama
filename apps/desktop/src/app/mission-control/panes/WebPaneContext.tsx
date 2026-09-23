import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  webviewCreate,
  webviewDestroy,
  webviewEval,
  webviewGoBack,
  webviewGoForward,
  webviewNavigate,
  webviewReload,
} from "../../../engine/client";
import { WINDOW_LABEL } from "../../../engine/window";
import { useProjectsData } from "../../data/ProjectsProvider";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M5/M6 — pages have no DB row and no protocol DTO. Like a
// PTY (§10 Open Question 1), a child webview dies with the window that owns it, so persisting a
// `web_pages` table would only ever describe state that's already gone by the time anyone reads
// it back. State instead lives in this one module-level store, not React state, because two
// different roots need it: WebPaneProvider (mounted only while the Web pane is the active pane,
// mirroring TerminalPaneContext) and AgentWebBridge (mounted unconditionally at AppShell's root,
// same reason as AgentTerminalBridge — a `browser open` from an agent working in a project the
// user isn't currently looking at must still work). A plain pub/sub is the smaller move than
// lifting this into a context both roots would need to sit under.

export type WebPageOwner = "user" | "agent";

export interface WebPageState {
  id: string;
  projectId: string;
  url: string;
  title: string;
  owner: WebPageOwner;
  originChatId: string | null;
  loading: boolean;
  createdAt: number;
}

let pages: WebPageState[] = [];
const storeListeners = new Set<() => void>();

function notify() {
  for (const l of storeListeners) l();
}

export function subscribeWebPages(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => storeListeners.delete(listener);
}

export function getWebPagesSnapshot(): WebPageState[] {
  return pages;
}

function patchPage(id: string, patch: Partial<WebPageState>) {
  pages = pages.map((p) => (p.id === id ? { ...p, ...patch } : p));
  notify();
}

export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  // Any URL that already names a scheme — including ones with no "//" (about:blank, data:...) —
  // is left alone. The old check required "://" specifically, which mangled "about:blank" (the
  // Rail's own "+" button default) into "https://about:blank", a bogus host that just errors.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

// Best-effort title pickup: webviewCreate/navigate resolve once the child webview exists, not
// once the page has actually loaded, and Rust deliberately doesn't emit a load-finished event
// (webview.rs keeps its surface to create/navigate/bounds/visible/destroy/eval — see its module
// doc).
//
// AGENT_BROWSER_PLAN.md AB5 — replaces the old five-poll ~4s guess (400ms, then four more 900ms
// spaced polls) with one real `__ramaSettle()` wait (hook.ts's always-on init script, so it's
// already present the instant the webview exists) followed by a single title/url read, instead
// of guessing how many polls a page needs.
async function refreshPageMeta(id: string): Promise<void> {
  if (!pages.some((p) => p.id === id)) return; // closed already
  await webviewEval(id, "return window.__ramaSettle ? window.__ramaSettle(5000) : Promise.resolve('');").catch(() => {
    // still loading (or the eval timed out) — read whatever title/url is there now regardless
  });
  if (!pages.some((p) => p.id === id)) return; // closed while settling
  try {
    const title = await webviewEval(id, "return (document.title || '').slice(0, 200);");
    const url = await webviewEval(id, "return String(location.href || '');").catch(() => undefined);
    patchPage(id, { ...(title ? { title } : {}), ...(url ? { url } : {}), loading: false });
  } catch {
    patchPage(id, { loading: false });
  }
}

// Exported standalone, not just through the context, so AgentWebBridge.tsx (mounted outside any
// pane's Provider tree — see the module doc above) and the Rail's `+` button share one code path.
export async function createWebPage(
  projectId: string,
  url: string,
  opts: { owner?: WebPageOwner; originChatId?: string } = {},
): Promise<WebPageState> {
  const id = crypto.randomUUID();
  const page: WebPageState = {
    id,
    projectId,
    url,
    title: url,
    owner: opts.owner ?? "user",
    originChatId: opts.originChatId ?? null,
    loading: true,
    createdAt: Date.now(),
  };
  // Publishing to the store (and thus mounting WebStage) before the native webview actually
  // exists on the Rust side used to be the whole bug: useWebviewVisibility's mount-time
  // `webview_set_bounds`/`webview_set_visible` calls would race webview_create, lose, get a
  // "no such page" error, and — since they only ever run again on a real bounds/visibility
  // change — never retry. The page would sit there permanently 1x1 and hidden, which is exactly
  // what "opening a page shows nothing" looks like. Awaiting creation first closes that race.
  try {
    await webviewCreate(WINDOW_LABEL, id, url);
  } catch (err) {
    // Rethrown (not swallowed): AgentWebBridge's `browser open` handler needs to see this to
    // report a real failure back through the tool instead of a false "opened" success — see its
    // outer try/catch. openPage below is the only UI caller and already catches for itself.
    console.error("[rama] failed to create web page", err);
    const failedPage: WebPageState = { ...page, loading: false };
    pages = [...pages, failedPage];
    notify();
    // Carries the (still-added, now failed) page so openPage below can focus it without
    // guessing at the store's contents; AgentWebBridge just wants err.message.
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { page: failedPage });
  }
  pages = [...pages, page];
  notify();
  void refreshPageMeta(id);
  return page;
}

export async function navigateWebPage(id: string, url: string): Promise<void> {
  patchPage(id, { url, loading: true });
  try {
    await webviewNavigate(id, url);
    void refreshPageMeta(id);
  } catch (err) {
    // Rethrown for the same reason as createWebPage above — callers that don't care (the
    // omnibox's `navigate` below) already catch for themselves.
    console.error("[rama] failed to navigate web page", err);
    patchPage(id, { loading: false });
    throw err;
  }
}

export async function closeWebPage(id: string): Promise<void> {
  pages = pages.filter((p) => p.id !== id);
  notify();
  await webviewDestroy(id).catch(() => {});
}

export function getWebPage(id: string): WebPageState | undefined {
  return pages.find((p) => p.id === id);
}

interface WebPaneValue {
  pages: WebPageState[];
  active: WebPageState | null;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  openPage: (url: string) => Promise<void>;
  navigate: (url: string) => Promise<void>;
  reload: () => Promise<void>;
  goBack: () => Promise<void>;
  goForward: () => Promise<void>;
  closePage: (id: string) => Promise<void>;
}

const WebPaneContext = createContext<WebPaneValue | null>(null);

export function WebPaneProvider({ children }: { children: ReactNode }) {
  const { activeProjectId } = useProjectsData();
  const allPages = useSyncExternalStore(subscribeWebPages, getWebPagesSnapshot);
  const [activeId, setActiveId] = useState<string | null>(null);

  const projectPages = useMemo(
    () => allPages.filter((p) => p.projectId === activeProjectId),
    [allPages, activeProjectId],
  );

  // Same "first load picks the newest, later arrivals don't steal focus" rule as
  // TerminalPaneContext — a fresh agent-opened page is usually the one worth looking at.
  useEffect(() => {
    if (projectPages.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !projectPages.some((p) => p.id === activeId)) {
      setActiveId(projectPages[projectPages.length - 1].id);
    }
  }, [projectPages, activeId]);

  const active = projectPages.find((p) => p.id === activeId) ?? null;

  const openPage = useCallback(
    async (url: string) => {
      if (!activeProjectId) return;
      // createWebPage now rethrows on failure (see its own comment) — this UI entry point still
      // just wants the page added in its failed state and focused, same as before.
      const page = await createWebPage(activeProjectId, normalizeUrl(url)).catch(
        (err: Error & { page?: WebPageState }) => err.page,
      );
      if (page) setActiveId(page.id);
    },
    [activeProjectId],
  );

  const navigate = useCallback(
    async (url: string) => {
      if (!active) return;
      await navigateWebPage(active.id, normalizeUrl(url)).catch(() => {});
    },
    [active],
  );

  // Native commands, not `webview_eval` — that ack round-trip signals completion with its own
  // navigation, which races the navigation these calls themselves trigger and can silently lose
  // (the button visibly does nothing). See webview.rs's comment on webview_reload for the story.
  const reload = useCallback(async () => {
    if (!active) return;
    patchPage(active.id, { loading: true });
    await webviewReload(active.id).catch(() => {});
    void refreshPageMeta(active.id);
  }, [active]);

  const goBack = useCallback(async () => {
    if (!active) return;
    patchPage(active.id, { loading: true });
    await webviewGoBack(active.id).catch(() => {});
    void refreshPageMeta(active.id);
  }, [active]);

  const goForward = useCallback(async () => {
    if (!active) return;
    patchPage(active.id, { loading: true });
    await webviewGoForward(active.id).catch(() => {});
    void refreshPageMeta(active.id);
  }, [active]);

  const closePage = useCallback(async (id: string) => {
    await closeWebPage(id);
    setActiveId((prev) => (prev === id ? null : prev));
  }, []);

  const value = useMemo<WebPaneValue>(
    () => ({ pages: projectPages, active, activeId, setActiveId, openPage, navigate, reload, goBack, goForward, closePage }),
    [projectPages, active, activeId, openPage, navigate, reload, goBack, goForward, closePage],
  );

  return <WebPaneContext.Provider value={value}>{children}</WebPaneContext.Provider>;
}

export function useWebPane(): WebPaneValue {
  const ctx = useContext(WebPaneContext);
  if (!ctx) throw new Error("useWebPane must be used within a WebPaneProvider");
  return ctx;
}
