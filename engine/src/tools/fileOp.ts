import { cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { mutate } from "./mutate";
import { resolveInProject } from "./paths";
import { runWithTimeout } from "./procRun";
import type { ToolCtx, ToolResult } from "./types";

async function isGitTracked(projectPath: string, relPath: string): Promise<boolean> {
  const { exitCode } = await runWithTimeout(["git", "ls-files", "--error-unmatch", relPath], {
    cwd: projectPath,
    timeoutMs: 5_000,
  });
  return exitCode === 0;
}

const inputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("move"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("copy"), from: z.string(), to: z.string() }),
  z.object({ op: z.literal("remove"), path: z.string(), recursive: z.boolean().optional() }),
  z.object({ op: z.literal("mkdir"), path: z.string() }),
]);

function pathsFor(input: z.infer<typeof inputSchema>): string[] {
  if (input.op === "move" || input.op === "copy") return [input.from, input.to];
  return [input.path];
}

// docs/TOOL_LAYER_PLAN.md §6.8 — thin, but it exists so the file lifecycle (move/copy/remove/
// mkdir) isn't invisible to checkpointing and the read tracker the way `bash mv` currently is.
export function createFileOpTool(ctx: ToolCtx) {
  return tool({
    description:
      "Move, copy, remove, or create a directory, scoped to the project directory. Uses `git mv` " +
      "for a move when the source is tracked, so its history follows the rename. Removing a " +
      "directory requires recursive: true.",
    inputSchema,
    execute: async (input): Promise<ToolResult> =>
      mutate(ctx, { name: "file_op", input, risk: "high", paths: pathsFor(input) }, async () => {
        if (input.op === "move") {
          const fromAbs = resolveInProject(ctx.projectPath, input.from);
          const toAbs = resolveInProject(ctx.projectPath, input.to);
          if (!existsSync(fromAbs)) {
            const msg = `no such file: ${input.from}`;
            return { ok: false, summary: msg, content: msg };
          }
          mkdirSync(dirname(toAbs), { recursive: true });
          const tracked = await isGitTracked(ctx.projectPath, input.from);
          let usedGitMv = false;
          if (tracked) {
            const { exitCode } = await runWithTimeout(["git", "mv", input.from, input.to], {
              cwd: ctx.projectPath,
              timeoutMs: 10_000,
            });
            usedGitMv = exitCode === 0;
          }
          if (!usedGitMv) renameSync(fromAbs, toAbs);
          return {
            ok: true,
            content: `moved ${input.from} → ${input.to}${usedGitMv ? " (git mv)" : ""}`,
            summary: "moved",
            meta: { filesWritten: [input.from, input.to] },
          };
        }

        if (input.op === "copy") {
          const fromAbs = resolveInProject(ctx.projectPath, input.from);
          const toAbs = resolveInProject(ctx.projectPath, input.to);
          if (!existsSync(fromAbs)) {
            const msg = `no such file: ${input.from}`;
            return { ok: false, summary: msg, content: msg };
          }
          mkdirSync(dirname(toAbs), { recursive: true });
          cpSync(fromAbs, toAbs, { recursive: true });
          return { ok: true, content: `copied ${input.from} → ${input.to}`, summary: "copied", meta: { filesWritten: [input.to] } };
        }

        if (input.op === "remove") {
          const abs = resolveInProject(ctx.projectPath, input.path);
          if (!existsSync(abs)) {
            const msg = `no such file: ${input.path}`;
            return { ok: false, summary: msg, content: msg };
          }
          if (statSync(abs).isDirectory() && !input.recursive) {
            const msg = `Refused: ${input.path} is a directory — pass recursive: true to remove it and its contents.`;
            return { ok: false, summary: msg, content: msg };
          }
          rmSync(abs, { recursive: !!input.recursive, force: false });
          return { ok: true, content: `removed ${input.path}`, summary: "removed", meta: { filesWritten: [input.path] } };
        }

        // mkdir
        const abs = resolveInProject(ctx.projectPath, input.path);
        mkdirSync(abs, { recursive: true });
        return { ok: true, content: `created directory ${input.path}`, summary: "created", meta: { filesWritten: [] } };
      }),
  });
}
