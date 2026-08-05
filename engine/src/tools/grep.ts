import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import { runWithTimeout } from "./procRun";
import type { ToolCtx, ToolResult } from "./types";

const EXCLUDE_DIRS = [".git", "node_modules", "dist", "build", "target", ".next", ".turbo"];
const MAX_LINES = 200;

export function createGrepTool(ctx: ToolCtx) {
  return tool({
    description: "Search file contents for a regex pattern, scoped to the project directory.",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional().describe("Path relative to the project root; defaults to the whole project"),
      caseInsensitive: z.boolean().optional(),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "grep", input, risk: "low" }, async () => {
        const searchPath = input.path ?? ".";
        resolveInProject(ctx.projectPath, searchPath); // throws if it escapes the project

        const args = ["grep", "-rn", ...EXCLUDE_DIRS.map((d) => `--exclude-dir=${d}`)];
        if (input.caseInsensitive) args.push("-i");
        args.push(input.pattern, searchPath);

        const { output, exitCode, timedOut } = await runWithTimeout(args, {
          cwd: ctx.projectPath,
          timeoutMs: 10_000,
          abortSignal: ctx.abortSignal,
        });

        if (timedOut) return { ok: false, summary: `grep timed out searching "${input.pattern}"` };
        if (exitCode !== 0 && !output.trim()) {
          return { ok: true, summary: `no matches for "${input.pattern}"` };
        }

        const allLines = output.split("\n").filter(Boolean);
        const fileCount = new Set(allLines.map((l) => l.split(":")[0])).size;
        const truncated = allLines.length > MAX_LINES;
        const body = truncated
          ? `${allLines.slice(0, MAX_LINES).join("\n")}\n… truncated (${allLines.length - MAX_LINES} more matches)`
          : allLines.join("\n");

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: `grep "${input.pattern}" ${searchPath}`,
          meta: { matches: allLines.length, files: fileCount },
          body,
        });
        return {
          ok: true,
          summary: `${allLines.length} matches across ${fileCount} file${fileCount === 1 ? "" : "s"}`,
          artifactId: artifact.id,
        };
      }),
  });
}
