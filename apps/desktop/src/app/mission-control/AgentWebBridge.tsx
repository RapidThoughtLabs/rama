import { useEffect } from "react";
import type { BrowserRequest } from "@rama/protocol";
import { postBrowserResponse, webviewEval } from "../../engine/client";
import { onProjectEvent, send } from "../../engine/ws";
import { useProjectsData } from "../data/ProjectsProvider";
import { createWebPage, getWebPage, getWebPagesSnapshot, navigateWebPage } from "./panes/WebPaneContext";
import type { WebPageState } from "./panes/WebPaneContext";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — the `browser` tool's counterpart to
// AgentTerminalBridge.tsx: the engine can't call a Tauri command itself, so `browser.request` is
// broadcast on the project topic and this always-mounted, invisible component does the actual
// webview work, then POSTs the result to engine/src/browserBridge.ts. Subscribes to every
// project's topic, not just the active one, for the same reason AgentTerminalBridge does — a
// `browser open` started by an agent working in a project the user isn't currently looking at
// must still work.

function mostRecentPage(projectId: string, ownerOnly?: "agent"): WebPageState | undefined {
  const list = getWebPagesSnapshot().filter((p) => p.projectId === projectId && (!ownerOnly || p.owner === ownerOnly));
  return list[list.length - 1];
}

async function settleAndDescribe(pageId: string, fallbackUrl: string): Promise<{ title: string; url: string }> {
  // Same best-effort settle as WebPaneContext's own refreshPageMeta — `open`'s response should
  // describe the page the agent will actually see, not the blank tab it started as.
  await new Promise((resolve) => setTimeout(resolve, 900));
  const title = await webviewEval(pageId, "return document.title || '';").catch(() => "");
  const url = await webviewEval(pageId, "return String(location.href || '');").catch(() => fallbackUrl);
  return { title, url };
}

async function handleBrowserRequest(projectId: string, request: BrowserRequest): Promise<void> {
  try {
    if (request.op === "open") {
      const url = request.url || "about:blank";
      // Reuses the agent's own most recent page in this project rather than piling up a new tab
      // per call — never a page the user opened themselves (mirrors §0.4's "read any shell, write
      // only to ones you created", applied to navigation instead of writes).
      const existing = mostRecentPage(projectId, "agent");
      let pageId: string;
      if (existing) {
        await navigateWebPage(existing.id, url);
        pageId = existing.id;
      } else {
        const page = await createWebPage(projectId, url, { owner: "agent", originChatId: request.chatId });
        pageId = page.id;
      }
      const { title, url: finalUrl } = await settleAndDescribe(pageId, url);
      await postBrowserResponse(request.requestId, { ok: true, pageId, title, url: finalUrl });
      return;
    }

    const page = request.pageId ? getWebPage(request.pageId) : mostRecentPage(projectId);
    if (!page) {
      await postBrowserResponse(request.requestId, {
        ok: false,
        error: "no page open in this project — use `browser open` first.",
      });
      return;
    }

    if (request.op === "read") {
      const text = await webviewEval(page.id, "return document.body ? document.body.innerText.slice(0, 20000) : '';");
      await postBrowserResponse(request.requestId, { ok: true, pageId: page.id, title: page.title, url: page.url, text });
      return;
    }

    if (request.op === "console") {
      const raw = await webviewEval(page.id, "return JSON.stringify((window.__ramaConsole || []).slice(-100));");
      let consoleLogs: string[] = [];
      try {
        consoleLogs = JSON.parse(raw);
      } catch {
        // leave empty — the page's console hook (webview.rs's CONSOLE_HOOK_SCRIPT) never wrote
        // valid JSON, most likely because no console output has happened yet
      }
      await postBrowserResponse(request.requestId, { ok: true, pageId: page.id, consoleLogs });
      return;
    }
  } catch (err) {
    await postBrowserResponse(request.requestId, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});
  }
}

export function AgentWebBridge() {
  const { projects } = useProjectsData();
  const projectIds = projects.map((p) => p.id).join(",");

  useEffect(() => {
    const ids = projectIds ? projectIds.split(",") : [];
    for (const id of ids) void send({ type: "subscribeProject", projectId: id });
    return () => {
      for (const id of ids) void send({ type: "unsubscribeProject", projectId: id });
    };
  }, [projectIds]);

  useEffect(() => {
    return onProjectEvent((projectId, event) => {
      if (event.type === "browser.request") void handleBrowserRequest(projectId, event.request);
    });
  }, []);

  return null;
}
