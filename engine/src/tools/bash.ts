import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { newId } from "../db/ids";
import { createTerminal, listTerminalsByProject } from "../db/terminals";
import { broadcast, broadcastProject } from "../ws";
import { classifyCommand, findHardRefusal, findShadow } from "./risk";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
// What goes to the model is capped much tighter than the artifact's full (100KB-capped, see
// shell.ts) output, and head+tail rather than head-only — a failing test run's summary is almost
// always at the end, and head-only truncation was cutting it off.
const MODEL_OUTPUT_CHARS = 8_000;
// docs/MISSION_CONTROL_PLAN.md §9 Risk 4 — a soft cap on this agent's own background shells per
// project; nothing else stops it spawning a new dev server on every run.
const MAX_AGENT_TERMINALS = 8;

// The one tool that streams live: the artifact row is created empty up front (so a card can
// appear immediately) and only written to the DB once, at the end, with the full output —
// the "streaming" experience in between is transport-only (artifact.updated deltas).
export function createBashTool(ctx: ToolCtx) {
  return tool({
    description:
      "Run a shell command in a persistent shell scoped to the project directory — cd and " +
      "exported vars carry over to your next call. Output (stdout+stderr) is captured and " +
      "truncated past ~100KB; the command is killed if it exceeds its timeout. A command a " +
      "native tool already covers (read, edit, write, file_op, glob, grep, git, git_write, check) " +
      "is redirected there instead of run — pass override to run it anyway. For a dev server, " +
      "watcher, or anything else that does not exit on its own, pass background: true instead of " +
      "letting it time out.",
    inputSchema: z.object({
      command: z.string(),
      timeoutMs: z.number().optional().describe(`Defaults to ${DEFAULT_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms`),
      background: z
        .boolean()
        .optional()
        .describe(
          "Run as a persistent shell the user can see and interact with in the Terminal pane, instead of " +
            "waiting for it to exit. Use for dev servers, watchers, and anything long-running. Returns a " +
            "terminalId immediately, with no output yet — read it afterward with `process`. The process " +
            "keeps running after this turn ends, and after you're interrupted or the run aborts; it is only " +
            "stopped by `process kill` or the app quitting.",
        ),
      override: z.boolean().optional().describe("Run even if a native tool covers this command. Prefer the native tool."),
    }),
    execute: async (input, options): Promise<ToolResult> => {
      // §5.6 hard-refuse — never worth executing, and `override` does not bypass it.
      const refusal = findHardRefusal(input.command);
      if (refusal) {
        return { ok: false, summary: "refused", content: `refused: ${refusal}. This will not be run, with or without override.` };
      }

      // §5.6 shadow detection — resolved (and, unless overridden, redirected) before any
      // permission prompt: no point asking the user to approve a command we're not going to run.
      if (!input.override) {
        const shadow = findShadow(input.command);
        if (shadow) {
          return {
            ok: false,
            summary: `use ${shadow.tool} instead`,
            content: `${shadow.message}. Pass override: true to \`bash\` to run it anyway if this is a genuine exception.`,
          };
        }
      }

      // docs/MISSION_CONTROL_PLAN.md §7.1 — background is always `high` risk regardless of what
      // the command itself would classify as: approving a foreground `npm test` and approving a
      // process that outlives the turn are materially different asks (§8 M4's permission-copy note).
      const risk = input.background ? "high" : classifyCommand(input.command);
      return gate(ctx, { name: "bash", input, risk }, async () => {
        // §7.1/§7.2 — the background path never touches ctx.shell (that session is run-scoped and
        // disposed on run end/abort, docs/TOOL_LAYER_PLAN.md §5.5 — exactly the lifetime this
        // process must NOT have). It creates a project-scoped `terminals` row instead, over the
        // Rust-owned PTY (Mission Control §6) — the engine can't call that Tauri command itself
        // (it's a headless Bun process), so it broadcasts `terminal.created` and a frontend bridge
        // (AgentTerminalBridge.tsx) does the actual `pty_spawn`.
        if (input.background) {
          const existingTerminals = listTerminalsByProject(ctx.projectId);
          // §9 Risk 4 — "nothing stops the agent spawning ten dev servers across ten runs." A
          // soft cap on this agent's own terminals; user-owned ones never count against it.
          const agentRunning = existingTerminals.filter((t) => t.owner === "agent" && t.status === "running").length;
          if (agentRunning >= MAX_AGENT_TERMINALS) {
            return {
              ok: false,
              summary: "refused: too many background shells",
              content:
                `refused: ${agentRunning} agent-owned terminals are already running in this project (max ${MAX_AGENT_TERMINALS}). ` +
                `Check \`process list\` and kill ones you no longer need before starting another.`,
            };
          }

          const shell = Bun.env.SHELL ?? "/bin/zsh";
          const cwd = ctx.shell.cwd();
          const index = existingTerminals.length + 1;
          const terminal = createTerminal({
            projectId: ctx.projectId,
            title: input.command,
            cwd,
            shell,
            argv: ["-lc", input.command],
            owner: "agent",
            originChatId: ctx.chatId,
          });
          broadcastProject(ctx.projectId, { type: "terminal.created", terminal });

          const artifactId = newId();
          const meta = { terminalId: terminal.id };
          const body = `started \`${input.command}\` → terminal ${index}`;
          broadcast(ctx.chatId, { type: "artifact.created", artifactId, kind: "terminal", name: input.command, meta });
          createArtifact({
            id: artifactId,
            chatId: ctx.chatId,
            projectId: ctx.projectId,
            toolCallId: options.toolCallId,
            kind: "terminal",
            name: input.command,
            meta,
            body,
            status: "done",
          });
          broadcast(ctx.chatId, { type: "artifact.updated", artifactId, status: "done" });

          return {
            ok: true,
            content:
              `started as terminal ${index} (cwd ${cwd}). No output yet — this returns immediately; ` +
              `use \`process read\` with id "${terminal.id}" to check on it, and \`process kill\` to stop it.`,
            summary: `background: terminal ${index}`,
            artifactId,
          };
        }

        const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const artifactId = newId();
        broadcast(ctx.chatId, { type: "artifact.created", artifactId, kind: "terminal", name: input.command, meta: {} });

        const cwdBefore = ctx.shell.cwd();
        const result = await ctx.shell.run(input.command, {
          timeoutMs,
          signal: ctx.abortSignal,
          // The client appends each delta to a running per-artifact buffer, so every chunk must
          // be forwarded exactly once and the final "done" broadcast below must carry no delta
          // of its own — the buffer built purely from these already equals `output`.
          onChunk: (text) => broadcast(ctx.chatId, { type: "artifact.updated", artifactId, delta: text, status: "streaming" }),
        });
        const output =
          (result.output || "(no output)") +
          (result.outputTruncated ? "\n… output truncated" : "") +
          (result.timedOut ? `\n… command timed out after ${timeoutMs}ms` : "") +
          (result.aborted ? "\n… aborted" : "");

        createArtifact({
          id: artifactId,
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: input.command,
          meta: { exitCode: result.exitCode },
          body: output,
          status: "done",
        });
        broadcast(ctx.chatId, { type: "artifact.updated", artifactId, status: "done" });

        const lineCount = output.split("\n").filter(Boolean).length;
        const summary = result.timedOut
          ? `timed out after ${timeoutMs}ms`
          : result.aborted
            ? "aborted"
            : `exit ${result.exitCode} · ${lineCount} line${lineCount === 1 ? "" : "s"}`;

        const { content: truncatedOutput, truncated } = headTailTruncate(output, MODEL_OUTPUT_CHARS);
        const cwdNote = result.cwd !== cwdBefore ? `\ncwd is now ${result.cwd}` : "";
        const resetNote = result.sessionReset && !result.timedOut && !result.aborted ? "\n(shell session was reset)" : "";
        const content = `${truncatedOutput}${cwdNote}${resetNote}`;

        return {
          ok: !result.timedOut && !result.aborted && result.exitCode === 0,
          content,
          summary,
          artifactId,
          meta: {
            durationMs: result.durationMs,
            ...(truncated
              ? {
                  truncated: {
                    shown: MODEL_OUTPUT_CHARS,
                    total: output.length,
                    unit: "bytes" as const,
                    how: "head+tail: first 30% and last 70% of output shown, middle omitted",
                  },
                }
              : {}),
          },
        };
      });
    },
  });
}
