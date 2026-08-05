import { readFileSync, writeFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { formatUnifiedDiff } from "./diffFormat";
import { resolveInProject } from "./paths";
import type { ToolCtx, ToolResult } from "./types";

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (true) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) return count;
    count++;
    from = idx + needle.length;
  }
}

export function createEditTool(ctx: ToolCtx) {
  return tool({
    description:
      "Replace an exact string in a file with another, scoped to the project directory. " +
      "oldString must match exactly once unless replaceAll is set.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "edit", input, risk: "high" }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);
        const content = readFileSync(abs, "utf8");
        const count = countOccurrences(content, input.oldString);

        if (count === 0) {
          return { ok: false, summary: `oldString not found in ${input.path}` };
        }
        if (count > 1 && !input.replaceAll) {
          return {
            ok: false,
            summary: `oldString appears ${count} times in ${input.path} — not unique; pass replaceAll or add more context`,
          };
        }

        const newContent = input.replaceAll
          ? content.split(input.oldString).join(input.newString)
          : content.replace(input.oldString, input.newString);
        writeFileSync(abs, newContent);

        const { text, added, removed } = formatUnifiedDiff(content, newContent);
        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "diff",
          name: input.path,
          meta: { added, removed },
          body: text,
        });
        return { ok: true, summary: `+${added} −${removed}`, artifactId: artifact.id };
      }),
  });
}
