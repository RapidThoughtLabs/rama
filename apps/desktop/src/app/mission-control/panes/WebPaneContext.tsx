import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { webviewCreate, webviewDestroy, webviewEval, webviewNavigate } from "../../../engine/client";
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
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  if (/^localhost(:\d+)?(\/|$)/i.test(trimmed) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(trimmed)) {
    return `http://${trimmed}`;
  }
  return `https://${trimmed}`;
}

// Best-effort title pickup: webviewCreate/navigate resolve once the child webview exists, not
// once the page has actually loaded, and Rust deliberately doesn't emit a load-finished event
// (webview.rs keeps its surface to create/navigate/bounds/visible/destroy/eval — see its module
// doc). A few spaced polls of the same `webview_eval` M6 already needs is simpler than adding a
// Tauri event just for this.
async function refreshPageMeta(id: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 400 : 900));
    if (!pages.some((p) => p.id === id)) return; // closed while we were polling
    try {
      const title = await webviewEval(id, "return (document.title || '').slice(0, 200);");
      const url = await webviewEval(id, "return String(location.href || '');").catch(() => undefined);
      if (title || url) {
        patchPage(id, { ...(title ? { title } : {}), ...(url ? { url } : {}), loading: false });
        return;
      }
    } catch {
      // still loading (or the eval timed out) — retry
    }
  }
  patchPage(id, { loading: false });
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
  pages = [...pages, page];
  notify();
  try {
    await webviewCreate(WINDOW_LABEL, id, url);
    void refreshPageMeta(id);
  } catch (err) {
    console.error("[rama] failed to create web page", err);
    patchPage(id, { loading: false });
  }
  return page;
}

export async function navigateWebPage(id: string, url: string): Promise<void> {
  patchPage(id, { url, loading: true });
  try {
    await webviewNavigate(id, url);
    void refreshPageMeta(id);
  } catch (err) {
    console.error("[rama] failed to navigate web page", err);
    patchPage(id, { loading: false });
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
      const page = await createWebPage(activeProjectId, normalizeUrl(url));
      setActiveId(page.id);
    },
    [activeProjectId],
  );

  const navigate = useCallback(
    async (url: string) => {
      if (!active) return;
      await navigateWebPage(active.id, normalizeUrl(url));
    },
    [active],
  );

  // Back/forward/reload reuse `webview_eval` (M6 needs it anyway) instead of adding three more
  // Rust commands — see webview.rs's module doc on keeping the unstable-API surface to one file.
  const reload = useCallback(async () => {
    if (!active) return;
    await webviewEval(active.id, "location.reload(); return '';").catch(() => {});
  }, [active]);

  const goBack = useCallback(async () => {
    if (!active) return;
    await webviewEval(active.id, "history.back(); return '';").catch(() => {});
  }, [active]);

  const goForward = useCallback(async () => {
    if (!active) return;
    await webviewEval(active.id, "history.forward(); return '';").catch(() => {});
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
