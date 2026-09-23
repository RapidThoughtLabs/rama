import { useEffect } from "react";
import type { BrowserRequest } from "@rama/protocol";
import { postBrowserResponse, webviewAction, webviewEval, webviewRead, webviewSnapshot } from "../../engine/client";
import { WINDOW_LABEL } from "../../engine/window";
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
  // AGENT_BROWSER_PLAN.md AB5 — real settle (hook.ts's always-on `__ramaSettle`, always present
  // since it's the init script every page gets) instead of a flat 900ms guess — `open`'s response
  // should describe the page the agent will actually see, not whatever loaded by an arbitrary
  // deadline. Same swap as WebPaneContext's own refreshPageMeta below.
  await webviewEval(pageId, "return window.__ramaSettle ? window.__ramaSettle(5000) : Promise.resolve('');").catch(() => {});
  const title = await webviewEval(pageId, "return document.title || '';").catch(() => "");
  const url = await webviewEval(pageId, "return String(location.href || '');").catch(() => fallbackUrl);
  return { title, url };
}

// AB0 Decision 11 — every response carries which window answered, so browserBridge.ts can
// address the *next* request for this project straight at it instead of broadcasting.
function respond(requestId: string, body: Omit<Parameters<typeof postBrowserResponse>[1], "windowLabel">) {
  return postBrowserResponse(requestId, { ...body, windowLabel: WINDOW_LABEL });
}

async function handleBrowserRequest(projectId: string, request: BrowserRequest): Promise<void> {
  // A request addressed to a specific window is ignored by every other window. Unset means the
  // bootstrap case or browser.ts's 2s-no-answer fallback re-broadcast, both of which every window
  // should still race for, same as before this phase.
  if (request.responderWindow && request.responderWindow !== WINDOW_LABEL) return;
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
      await respond(request.requestId, { ok: true, pageId, title, url: finalUrl });
      return;
    }

    const page = request.pageId ? getWebPage(request.pageId) : mostRecentPage(projectId);
    if (!page) {
      await respond(request.requestId, {
        ok: false,
        error: "no page open in this project — use `browser open` first.",
      });
      return;
    }

    if (request.op === "read") {
      // AGENT_BROWSER_PLAN.md AB3 §6.3 — routes through Readability→Turndown (read.ts, lazy-
      // loaded via webviewRead the same way webviewSnapshot loads the DOM bundle), falling back
      // to innerText and saying so via `readMode`/`readFallbackReason` rather than silently.
      const raw = await webviewRead(page.id);
      const parsed = JSON.parse(raw) as { markdown: string; mode: "readability" | "innerText"; fallbackReason?: string };
      await respond(request.requestId, {
        ok: true,
        pageId: page.id,
        title: page.title,
        url: page.url,
        text: parsed.markdown,
        readMode: parsed.mode,
        readFallbackReason: parsed.fallbackReason,
      });
      return;
    }

    if (request.op === "console") {
      // AGENT_BROWSER_PLAN.md AB3 — `__ramaConsoleSince` (hook.ts) merges console entries with
      // failed network requests, filters by `since`, and keeps errors/warnings over plain logs
      // when the combined set has to be truncated. `lastSeq` (the newest entry's seq, or the
      // page's current counter when nothing matched) lets the tool tell the model what to pass
      // as `since` next time instead of re-reading the whole ring on every call.
      const sinceArg = request.since !== undefined ? String(request.since) : "undefined";
      const raw = await webviewEval(
        page.id,
        `var __e = JSON.parse(window.__ramaConsoleSince(${sinceArg})); return JSON.stringify({ entries: __e, lastSeq: __e.length ? __e[__e.length-1].seq : (window.__ramaNextSeq ? window.__ramaNextSeq() - 1 : 0) });`,
      );
      let entries: { level: string; text: string }[] = [];
      let lastSeq = 0;
      try {
        const parsed = JSON.parse(raw) as { entries: { level: string; text: string }[]; lastSeq: number };
        entries = parsed.entries;
        lastSeq = parsed.lastSeq;
      } catch {
        // leave empty — the page's hook (packages/page-runtime/src/hook.ts) never wrote valid
        // JSON, most likely because no console/network activity has happened yet
      }
      const consoleLogs = entries.map((e) => `${e.level}: ${e.text}`);
      await respond(request.requestId, { ok: true, pageId: page.id, url: page.url, consoleLogs, lastSeq });
      return;
    }

    if (request.op === "snapshot") {
      const raw = await webviewSnapshot(page.id, request.depth);
      const parsed = JSON.parse(raw) as { text: string; gen: number; refCount: number };
      await respond(request.requestId, {
        ok: true,
        pageId: page.id,
        url: page.url,
        snapshot: parsed.text,
        gen: parsed.gen,
        refCount: parsed.refCount,
      });
      return;
    }

    if (request.op === "click" || request.op === "type" || request.op === "press" || request.op === "scroll") {
      // AGENT_BROWSER_PLAN.md AB4/AB5 — `webviewAction`'s payload mirrors dom.ts's `ActionOp`
      // union exactly; the ref resolution / stale-ref errors, and now the settle+diff, all live
      // there, not here.
      const actionJson = JSON.stringify(
        request.op === "click"
          ? { op: "click", ref: request.ref, full: request.full }
          : request.op === "type"
            ? { op: "type", ref: request.ref, text: request.text, submit: request.submit, full: request.full }
            : request.op === "press"
              ? { op: "press", key: request.key, full: request.full }
              : { op: "scroll", to: request.to, full: request.full },
      );
      const raw = await webviewAction(page.id, actionJson);
      const outcome = JSON.parse(raw) as {
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
      // The wire protocol collapses actions.ts's warning/error distinction into one `error`
      // string — both mean "the action didn't happen, here's why" from the tool layer's side.
      await respond(request.requestId, {
        ok: outcome.ok,
        pageId: page.id,
        url: page.url,
        error: outcome.error ?? outcome.warning,
        settleReason: outcome.settleReason,
        settleMs: outcome.settleMs,
        genFrom: outcome.genFrom,
        gen: outcome.genTo,
        diff: outcome.diff,
        full: outcome.full,
        snapshot: outcome.snapshot,
        refCount: outcome.refCount,
        consoleLogs: outcome.console,
      });
      return;
    }
  } catch (err) {
    await respond(request.requestId, {
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
