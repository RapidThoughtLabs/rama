import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { newId } from "../db/ids";
import { broadcast } from "../ws";
import type { ToolCtx, ToolResult } from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100_000;

// The one tool that streams live: the artifact row is created empty up front (so a card can
// appear immediately) and only written to the DB once, at the end, with the full output —
// the "streaming" experience in between is transport-only (artifact.updated deltas).
export function createBashTool(ctx: ToolCtx) {
  return tool({
    description:
      "Run a shell command, scoped to the project directory. Output (stdout+stderr) is captured " +
      "and truncated past ~100KB; the command is killed if it exceeds its timeout.",
    inputSchema: z.object({
      command: z.string(),
      timeoutMs: z.number().optional().describe(`Defaults to ${DEFAULT_TIMEOUT_MS}ms, capped at ${MAX_TIMEOUT_MS}ms`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "bash", input, risk: "high" }, async () => {
        const timeoutMs = Math.min(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
        const artifactId = newId();
        broadcast(ctx.chatId, { type: "artifact.created", artifactId, kind: "terminal", name: input.command, meta: {} });

        const proc = Bun.spawn({
          cmd: ["/bin/sh", "-c", input.command],
          cwd: ctx.projectPath,
          stdout: "pipe",
          stderr: "pipe",
        });

        let output = "";
        let outputTruncated = false;
        const decoder = new TextDecoder();

        const pump = async (stream: ReadableStream<Uint8Array>) => {
          for await (const chunk of stream) {
            const text = decoder.decode(chunk, { stream: true });
            if (output.length >= MAX_OUTPUT_BYTES) {
              outputTruncated = true;
              continue;
            }
            const remaining = MAX_OUTPUT_BYTES - output.length;
            const piece = text.length > remaining ? text.slice(0, remaining) : text;
            if (text.length > remaining) outputTruncated = true;
            output += piece;
            broadcast(ctx.chatId, { type: "artifact.updated", artifactId, delta: piece, status: "streaming" });
          }
        };

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
        const onAbort = () => proc.kill();
        ctx.abortSignal.addEventListener("abort", onAbort, { once: true });

        await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
        const exitCode = await proc.exited;
        clearTimeout(timer);
        ctx.abortSignal.removeEventListener("abort", onAbort);

        if (outputTruncated) output += "\n… output truncated";
        if (timedOut) output += `\n… command timed out after ${timeoutMs}ms`;

        createArtifact({
          id: artifactId,
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: input.command,
          meta: { exitCode },
          body: output || "(no output)",
          status: "done",
        });
        broadcast(ctx.chatId, { type: "artifact.updated", artifactId, status: "done" });

        const lineCount = output.split("\n").filter(Boolean).length;
        const summary = timedOut
          ? `timed out after ${timeoutMs}ms`
          : `exit ${exitCode} · ${lineCount} line${lineCount === 1 ? "" : "s"}`;
        return { ok: exitCode === 0 && !timedOut, summary, artifactId };
      }),
  });
}
