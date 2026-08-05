import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import type { ToolCtx, ToolResult } from "./types";

export function createLsTool(ctx: ToolCtx) {
  return tool({
    description: "List a directory's contents, scoped to the project directory.",
    inputSchema: z.object({ path: z.string().optional().describe("Path relative to the project root; defaults to the project root") }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "ls", input, risk: "low" }, async () => {
        const relPath = input.path ?? ".";
        const abs = resolveInProject(ctx.projectPath, relPath);
        const entries = readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));

        const lines = entries.map((entry) => {
          if (entry.isDirectory()) return `d       ${entry.name}/`;
          const size = statSync(join(abs, entry.name)).size;
          return `f ${String(size).padStart(7)} ${entry.name}`;
        });

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: `ls ${relPath}`,
          meta: { entries: entries.length },
          body: lines.join("\n") || "(empty directory)",
        });
        return { ok: true, summary: `${entries.length} entries`, artifactId: artifact.id };
      }),
  });
}
