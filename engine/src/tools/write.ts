import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { formatUnifiedDiff } from "./diffFormat";
import { resolveInProject } from "./paths";
import type { ToolCtx, ToolResult } from "./types";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

export function createWriteTool(ctx: ToolCtx) {
  return tool({
    description: "Create or overwrite a file, scoped to the project directory.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      content: z.string(),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "write", input, risk: "high" }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);
        const existedBefore = existsSync(abs);
        const oldContent = existedBefore ? readFileSync(abs, "utf8") : "";

        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.content);

        if (existedBefore) {
          const { text, added, removed } = formatUnifiedDiff(oldContent, input.content);
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
        }

        const lines = input.content.split("\n").length;
        const kind = DOC_EXTENSIONS.has(extname(input.path).toLowerCase()) ? "doc" : "code";
        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind,
          name: input.path,
          meta: { lines },
          body: input.content,
        });
        return { ok: true, summary: `created · ${lines} lines`, artifactId: artifact.id };
      }),
  });
}
