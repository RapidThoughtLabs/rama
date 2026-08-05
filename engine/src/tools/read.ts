import { readFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import type { ToolCtx, ToolResult } from "./types";

const MAX_LINES = 4000;

export function createReadTool(ctx: ToolCtx) {
  return tool({
    description: "Read a file's contents, scoped to the project directory.",
    inputSchema: z.object({ path: z.string().describe("Path relative to the project root") }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "read", input, risk: "low" }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);
        const content = readFileSync(abs, "utf8");
        const allLines = content.split("\n");
        const truncated = allLines.length > MAX_LINES;
        const body = truncated
          ? `${allLines.slice(0, MAX_LINES).join("\n")}\n… truncated (${allLines.length - MAX_LINES} more lines)`
          : content;

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "code",
          name: input.path,
          meta: { lines: allLines.length },
          body,
        });

        return { ok: true, summary: `${allLines.length} lines · added to context`, artifactId: artifact.id };
      }),
  });
}
