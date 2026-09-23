import { defineTool } from "./define";
import { z } from "zod";
import { getLastPageId, getPageOrigin, getResponderWindow, waitForBrowserResponse } from "../browserBridge";
import { gate, resolveBrowserActionRule } from "../agent/permissions";
import { newId } from "../db/ids";
import { broadcastProject } from "../ws";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";
import type { BrowserRequest } from "@rama/protocol";

// AGENT_BROWSER_PLAN.md AB5 §6.2 — the fields an action op's response carries once the page has
// settled: what changed (or the whole new snapshot, with `full`), and what broke. A subset of
// `BrowserResponseBody`, named separately so `formatActionOutcome` doesn't have to import the
// whole (much wider) response type just to describe the slice it actually reads.
export interface ActionOutcomeFields {
  settleReason?: string;
  settleMs?: number;
  genFrom?: number;
  gen?: number;
  diff?: string[];
  full?: boolean;
  snapshot?: string;
  refCount?: number;
  consoleLogs?: string[];
}

// AGENT_BROWSER_PLAN.md AB5 §6.2 — assembles the settled-and-diffed result block: what I did,
// whether the page settled, what changed, what broke. Exported and unit-tested on its own
// (browser.test.ts), since it's the piece the "under 300 tokens for a typical step" budget is
// actually about — the transport around it (webview eval, the protocol round trip, the WS hop)
// can't run inside a plain `bun test` process the way this pure formatter can.
export function formatActionOutcome(verb: string, res: ActionOutcomeFields): string {
  const lines: string[] = [verb];

  if (res.settleReason !== undefined) {
    const genNote = res.genFrom !== undefined && res.gen !== undefined ? `  ·  gen ${res.genFrom} → ${res.gen}` : "";
    lines.push(
      res.settleReason.startsWith("timed out")
        ? `settled: ${res.settleReason}${genNote}`
        : `settled in ${((res.settleMs ?? 0) / 1000).toFixed(1)}s (${res.settleReason})${genNote}`,
    );
  }

  lines.push("");
  if (res.full) {
    lines.push(res.snapshot || "(empty snapshot)");
  } else if (res.diff && res.diff.length) {
    lines.push(res.diff.join("\n"));
  } else {
    lines.push("(no changes)");
  }

  if (res.consoleLogs && res.consoleLogs.length) {
    lines.push("", `${res.consoleLogs.length} console/network ${res.consoleLogs.length === 1 ? "entry" : "entries"} since:`);
    lines.push(...res.consoleLogs.map((l) => `  ${l}`));
  }

  return lines.join("\n");
}

// AGENT_BROWSER_PLAN.md AB0 Decision 11 — a request addressed to a specific window (the one that
// last answered for this project) gets 2s to respond before this falls back to the old broadcast-
// to-everyone behaviour. Short enough that a real window answers well within it; long enough that
// it's not a race against the eval round-trip itself.
const RESPONDER_FALLBACK_MS = 2_000;

// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — "the reason the Web pane exists." Gated by the
// `web` PermissionTool slot (packages/protocol/src/index.ts), which had no tool wired to it
// until now; only `open` is gated (§0-style: it's the op with a real side effect — navigating
// somewhere new — the same way `process`'s `list`/`read` are ungated and only `kill` is).
const OPEN_TIMEOUT_MS = 20_000;
// AGENT_BROWSER_PLAN.md AB3 — `read` now injects the same DOM bundle `snapshot` does and runs
// Readability over a cloned document, so it needs the same budget as snapshot, not the old plain-
// eval 8s.
const READ_TIMEOUT_MS = 15_000;
const CONSOLE_TIMEOUT_MS = 8_000;
// AGENT_BROWSER_PLAN.md AB2 — a snapshot injects ~18KB of runtime and walks a real DOM, which is
// slower than the plain `webview_eval` calls `read`/`console` make; `webview_snapshot`'s own
// native-side default is 15s, and this has to be at least that or every slow page times out here
// first with a less useful error.
const SNAPSHOT_TIMEOUT_MS = 15_000;
// AGENT_BROWSER_PLAN.md AB4 — action ops dispatch synthetic events after (cheaply) re-sending the
// DOM bundle; faster than a snapshot's full walk, slower than a plain eval.
const ACTION_TIMEOUT_MS = 10_000;
const MODEL_OUTPUT_CHARS = 8_000;

const ACTION_OPS = new Set(["click", "type", "press", "scroll"] as const);
type ActionOp = "click" | "type" | "press" | "scroll";
function isActionOp(op: string): op is ActionOp {
  return ACTION_OPS.has(op as ActionOp);
}

export function createBrowserTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "Open and inspect web pages in the Web pane, visible to the user the same way `bash background:true` " +
      "shells show up in the Terminal pane. `open` navigates to a URL (creating a new page if none is " +
      "open) and returns its id. `snapshot` returns a numbered list of what's on the page — links, " +
      "buttons, form fields, each with a `[ref]` — the normal way to see what's there and what you can do " +
      "to it after starting a dev server with `bash background:true` and opening it; pass `depth: \"full\"` " +
      "to also see prose text, not just interactive elements. `click`/`type`/`press`/`scroll` act on a " +
      "`[ref]` from the most recent `snapshot` — a ref is always exact or it errors, never a guess, so " +
      "take a fresh snapshot after anything that changes the page before reusing an old ref. Every action " +
      "waits for the page to settle (network idle, DOM stable) and returns what changed as a +/-/~ diff, " +
      "not just a bare acknowledgement — pass `full: true` to get the whole new snapshot instead of a " +
      "diff. `read` extracts the page as markdown prose (falling back to raw text for non-article pages) " +
      "instead of acting on it. `console` reads console output and failed network requests since an " +
      "optional `since` seq (returned as `lastSeq` — pass it back next time to see only what's new).",
    inputSchema: z.discriminatedUnion("op", [
      z.object({ op: z.literal("open"), url: z.string() }),
      z.object({ op: z.literal("read"), id: z.string().optional().describe("Page id — omit for the active page in the Web pane.") }),
      z.object({
        op: z.literal("snapshot"),
        id: z.string().optional(),
        depth: z.enum(["outline", "full"]).optional().describe("outline (default): interactive elements + headings only. full: also includes prose text."),
      }),
      z.object({
        op: z.literal("console"),
        id: z.string().optional(),
        since: z.number().optional().describe("Only entries after this seq (from a previous call's `lastSeq`). Omit for everything in the buffer."),
      }),
      z.object({
        op: z.literal("click"),
        ref: z.number().describe("A `[ref]` number from the most recent snapshot."),
        full: z.boolean().optional().describe("Return the whole new snapshot instead of just a diff."),
        id: z.string().optional(),
      }),
      z.object({
        op: z.literal("type"),
        ref: z.number().describe("A `[ref]` number from the most recent snapshot — must point at an input, textarea, or contenteditable element."),
        text: z.string(),
        submit: z.boolean().optional().describe("Press Enter after typing (submits a form if the field is in one)."),
        full: z.boolean().optional().describe("Return the whole new snapshot instead of just a diff."),
        id: z.string().optional(),
      }),
      z.object({
        op: z.literal("press"),
        key: z.string().describe('A key name, e.g. "Enter", "Escape", "Tab".'),
        full: z.boolean().optional().describe("Return the whole new snapshot instead of just a diff."),
        id: z.string().optional(),
      }),
      z.object({
        op: z.literal("scroll"),
        to: z.union([z.literal("top"), z.literal("bottom"), z.number()]).describe('"top", "bottom", or a pixel offset from the top.'),
        full: z.boolean().optional().describe("Return the whole new snapshot instead of just a diff."),
        id: z.string().optional(),
      }),
    ]),
    execute: async (input): Promise<ToolResult> => {
      // AGENT_BROWSER_PLAN.md AB4 — for action ops, resolve the target page *before* broadcasting
      // so the permission gate below can check the right page's origin, and so the request sent
      // to the frontend names the exact page that was gated (not left to the frontend's own
      // "most recent page" guess, which could in principle differ). Explicit `id` always wins.
      const explicitPageId = "id" in input ? input.id : undefined;
      const resolvedPageId = explicitPageId ?? (isActionOp(input.op) ? getLastPageId(ctx.projectId) : undefined);

      const runRequest = async (): Promise<ToolResult> => {
        const requestId = newId();
        const responderWindow = getResponderWindow(ctx.projectId);
        const request: BrowserRequest = {
          requestId,
          op: input.op,
          url: input.op === "open" ? input.url : undefined,
          pageId: input.op === "open" ? undefined : resolvedPageId,
          chatId: input.op === "open" ? ctx.chatId : undefined,
          depth: input.op === "snapshot" ? input.depth : undefined,
          since: input.op === "console" ? input.since : undefined,
          ref: input.op === "click" || input.op === "type" ? input.ref : undefined,
          text: input.op === "type" ? input.text : undefined,
          submit: input.op === "type" ? input.submit : undefined,
          key: input.op === "press" ? input.key : undefined,
          to: input.op === "scroll" ? input.to : undefined,
          full: input.op === "click" || input.op === "type" || input.op === "press" || input.op === "scroll" ? input.full : undefined,
          responderWindow,
        };
        broadcastProject(ctx.projectId, { type: "browser.request", request });

        // If a specific window was addressed and it's gone quiet (closed, crashed, never had
        // this project's Web pane open), fall back to the pre-AB0 broadcast-to-everyone
        // behaviour rather than hanging until the full op timeout.
        let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
        if (responderWindow) {
          fallbackTimer = setTimeout(() => {
            broadcastProject(ctx.projectId, {
              type: "browser.request",
              request: { ...request, responderWindow: undefined },
            });
          }, RESPONDER_FALLBACK_MS);
        }

        const timeoutMs =
          input.op === "open"
            ? OPEN_TIMEOUT_MS
            : input.op === "snapshot"
              ? SNAPSHOT_TIMEOUT_MS
              : input.op === "read"
                ? READ_TIMEOUT_MS
                : input.op === "console"
                  ? CONSOLE_TIMEOUT_MS
                  : ACTION_TIMEOUT_MS;
        const res = await waitForBrowserResponse(requestId, timeoutMs, ctx.projectId);
        clearTimeout(fallbackTimer);
        if (!res.ok) {
          return { ok: false, summary: `browser ${input.op} failed`, content: res.error ?? "unknown error" };
        }

        if (input.op === "open") {
          return {
            ok: true,
            summary: `opened ${res.url ?? input.url}`,
            content: `page ${res.pageId} — ${res.title || "(untitled)"} — ${res.url ?? input.url}`,
          };
        }

        if (input.op === "read") {
          const { content, truncated } = headTailTruncate(res.text ?? "", MODEL_OUTPUT_CHARS);
          const modeNote =
            res.readMode === "readability" ? "extracted as article" : `full page text${res.readFallbackReason ? ` — ${res.readFallbackReason}` : ""}`;
          return {
            ok: true,
            summary: `read ${res.title || res.url || "page"} (${modeNote})`,
            content: content || "(page has no visible text)",
            meta: truncated
              ? {
                  truncated: {
                    shown: MODEL_OUTPUT_CHARS,
                    total: (res.text ?? "").length,
                    unit: "bytes" as const,
                    how: "head+tail: first 30% and last 70% of output shown, middle omitted",
                  },
                }
              : undefined,
          };
        }

        if (input.op === "snapshot") {
          const { content, truncated } = headTailTruncate(res.snapshot ?? "", MODEL_OUTPUT_CHARS);
          return {
            ok: true,
            summary: `snapshot of ${res.title || res.url || "page"} — ${res.refCount ?? 0} interactive elements (gen ${res.gen ?? "?"})`,
            content: content || "(empty snapshot)",
            meta: truncated
              ? {
                  truncated: {
                    shown: MODEL_OUTPUT_CHARS,
                    total: (res.snapshot ?? "").length,
                    unit: "bytes" as const,
                    how: "head+tail: first 30% and last 70% of output shown, middle omitted",
                  },
                }
              : undefined,
          };
        }

        if (input.op === "console") {
          const logs = res.consoleLogs ?? [];
          const seqNote = res.lastSeq !== undefined ? ` (up to seq ${res.lastSeq} — pass since: ${res.lastSeq} next time for only new entries)` : "";
          return {
            ok: true,
            summary: `${logs.length} console/network entries${seqNote}`,
            content: logs.join("\n") || "(no console output)",
          };
        }

        // op === "click" | "type" | "press" | "scroll"
        const verb =
          input.op === "click"
            ? `clicked [${input.ref}]`
            : input.op === "type"
              ? `typed into [${input.ref}]${input.submit ? " and submitted" : ""}`
              : input.op === "press"
                ? `pressed ${input.key}`
                : `scrolled to ${input.to}`;
        // AGENT_BROWSER_PLAN.md AB5 — the settled+diffed result, assembled by the pure formatter
        // above so its own token-budget test can run without a live webview.
        const diffCount = res.diff?.length ?? 0;
        const summary = res.full
          ? `${verb} — full snapshot (${res.refCount ?? 0} interactive elements)`
          : `${verb} — ${diffCount} change${diffCount === 1 ? "" : "s"}`;
        const formatted = formatActionOutcome(verb, res);
        const { content, truncated } = headTailTruncate(formatted, MODEL_OUTPUT_CHARS);
        return {
          ok: true,
          summary,
          content,
          meta: truncated
            ? {
                truncated: {
                  shown: MODEL_OUTPUT_CHARS,
                  total: formatted.length,
                  unit: "bytes" as const,
                  how: "head+tail: first 30% and last 70% of output shown, middle omitted",
                },
              }
            : undefined,
        };
      };

      if (input.op === "open") {
        return gate(ctx, { name: "browser", input, risk: "high" }, runRequest);
      }
      if (isActionOp(input.op)) {
        const origin = resolvedPageId ? getPageOrigin(resolvedPageId) : undefined;
        const rule = resolveBrowserActionRule(ctx.projectId, origin);
        return gate(ctx, { name: "browser", input, risk: "high", rule }, runRequest);
      }
      return runRequest();
    },
  });
}
