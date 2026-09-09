import { defineTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { getScrollback, getTerminal, listTerminalsByProject } from "../db/terminals";
import { broadcastProject } from "../ws";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

// docs/MISSION_CONTROL_PLAN.md §7.3 / §8 Phase M4 (docs/TOOL_LAYER_PLAN.md §6.10, TL3) —
// project-scoped: every op sees every terminal in `ctx.projectId`, not just this chat's own,
// which is the whole point of §0.4 ("the agent can read any shell, but only write to shells it
// created"). Cross-project ids are treated as not-found, not a permission error.
const MODEL_OUTPUT_CHARS = 8_000;

export function createProcessTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "Inspect or control terminals in this project (both this agent's own background shells from " +
      "`bash background:true` and the user's own). `list` shows every terminal with its status; " +
      "`read` tails one's scrollback; `kill` stops one — refused on a terminal the user started " +
      "themselves.",
    inputSchema: z.discriminatedUnion("op", [
      z.object({ op: z.literal("list") }),
      z.object({ op: z.literal("read"), id: z.string(), since: z.number().optional().describe("Character offset into scrollback to read from — omit for the full (head+tail-capped) transcript.") }),
      z.object({ op: z.literal("kill"), id: z.string() }),
    ]),
    execute: async (input): Promise<ToolResult> => {
      if (input.op === "list") {
        const terminals = listTerminalsByProject(ctx.projectId);
        if (terminals.length === 0) {
          return { ok: true, content: "no terminals in this project.", summary: "0 terminals" };
        }
        const lines = terminals.map((t, i) => {
          const status = t.status === "exited" ? `exited ${t.exitCode ?? "?"}` : "running";
          return `${i + 1}. id=${t.id} "${t.title}" [${t.owner}, ${status}] cwd=${t.cwd}`;
        });
        return {
          ok: true,
          content: lines.join("\n"),
          summary: `${terminals.length} terminal${terminals.length === 1 ? "" : "s"}`,
        };
      }

      const terminal = getTerminal(input.id);
      if (!terminal || terminal.projectId !== ctx.projectId) {
        return { ok: false, summary: "not found", content: `no terminal "${input.id}" in this project.` };
      }

      if (input.op === "read") {
        const full = getScrollback(terminal.id) ?? "";
        const since = typeof input.since === "number" ? Math.max(0, input.since) : 0;
        const sliced = full.slice(since) || "(no output yet)";
        const { content, truncated } = headTailTruncate(sliced, MODEL_OUTPUT_CHARS);
        const statusNote = terminal.status === "exited" ? ` · exited ${terminal.exitCode}` : " · running";
        return {
          ok: true,
          content,
          summary: `${sliced.length} chars${statusNote}`,
          meta: truncated
            ? {
                truncated: {
                  shown: MODEL_OUTPUT_CHARS,
                  total: sliced.length,
                  unit: "bytes" as const,
                  how: "head+tail: first 30% and last 70% of output shown, middle omitted",
                },
              }
            : undefined,
        };
      }

      // op === "kill"
      return gate(ctx, { name: "process", input, risk: "high" }, async () => {
        // §0.4 — refuses on `owner: 'user'`. A ToolResult the model reads and reacts to, not a
        // thrown error (docs/TOOL_LAYER_PLAN.md's ToolResult contract).
        if (terminal.owner === "user") {
          return {
            ok: false,
            summary: "refused: user-owned",
            content: `terminal ${terminal.id} ("${terminal.title}") is user-owned; ask the user to stop it.`,
          };
        }
        if (terminal.status === "exited") {
          return { ok: true, summary: "already exited", content: `terminal ${terminal.id} already exited (code ${terminal.exitCode}).` };
        }
        // Fire-and-forget, same reason as bash.ts's background path: the engine can't call the
        // Tauri `pty_kill` command itself — AgentTerminalBridge.tsx does the actual kill and
        // marks the row exited once it has.
        broadcastProject(ctx.projectId, { type: "terminal.kill_requested", terminalId: terminal.id });
        return { ok: true, summary: "kill requested", content: `kill requested for terminal ${terminal.id} ("${terminal.title}").` };
      });
    },
  });
}
