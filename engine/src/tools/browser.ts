import { tool } from "ai";
import { z } from "zod";
import { waitForBrowserResponse } from "../browserBridge";
import { gate } from "../agent/permissions";
import { newId } from "../db/ids";
import { broadcastProject } from "../ws";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M6 — "the reason the Web pane exists." Gated by the
// `web` PermissionTool slot (packages/protocol/src/index.ts), which had no tool wired to it
// until now; only `open` is gated (§0-style: it's the op with a real side effect — navigating
// somewhere new — the same way `process`'s `list`/`read` are ungated and only `kill` is).
const OPEN_TIMEOUT_MS = 20_000;
const READ_TIMEOUT_MS = 8_000;
const MODEL_OUTPUT_CHARS = 8_000;

export function createBrowserTool(ctx: ToolCtx) {
  return tool({
    description:
      "Open and read web pages in the Web pane, visible to the user the same way `bash background:true` " +
      "shells show up in the Terminal pane. `open` navigates to a URL (creating a new page if none is " +
      "open) and returns its id; `read` extracts the page's visible text — the normal way to see what " +
      "rendered after starting a dev server with `bash background:true` and opening it. `console` reads " +
      "the page's console output. `snapshot` is a screenshot for vision-capable models; on models or " +
      "builds where that isn't wired up it fails clearly rather than silently returning nothing.",
    inputSchema: z.discriminatedUnion("op", [
      z.object({ op: z.literal("open"), url: z.string() }),
      z.object({ op: z.literal("read"), id: z.string().optional().describe("Page id — omit for the active page in the Web pane.") }),
      z.object({ op: z.literal("snapshot"), id: z.string().optional() }),
      z.object({ op: z.literal("console"), id: z.string().optional() }),
    ]),
    execute: async (input): Promise<ToolResult> => {
      if (input.op === "snapshot") {
        // Honest stub rather than a fake/partial capture pipeline this pass can't verify end to
        // end (no way to exercise a real Tauri window from here) — see docs/MISSION_CONTROL_PLAN.md
        // §8 M6's own allowance for "not supported by this model" as a legitimate answer.
        return {
          ok: false,
          summary: "snapshot not supported",
          content: "screenshot capture isn't wired up in this build yet — use `browser read` for text content instead.",
        };
      }

      const runRequest = async (): Promise<ToolResult> => {
        const requestId = newId();
        broadcastProject(ctx.projectId, {
          type: "browser.request",
          request: {
            requestId,
            op: input.op,
            url: input.op === "open" ? input.url : undefined,
            pageId: "id" in input ? input.id : undefined,
            chatId: input.op === "open" ? ctx.chatId : undefined,
          },
        });
        const timeoutMs = input.op === "open" ? OPEN_TIMEOUT_MS : READ_TIMEOUT_MS;
        const res = await waitForBrowserResponse(requestId, timeoutMs);
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
          return {
            ok: true,
            summary: `read ${res.title || res.url || "page"}`,
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

        // op === "console"
        const logs = res.consoleLogs ?? [];
        return {
          ok: true,
          summary: `${logs.length} console entries`,
          content: logs.join("\n") || "(no console output)",
        };
      };

      if (input.op === "open") {
        return gate(ctx, { name: "browser", input, risk: "high" }, runRequest);
      }
      return runRequest();
    },
  });
}
