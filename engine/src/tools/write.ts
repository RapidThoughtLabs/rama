import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { createArtifact } from "../db/artifacts";
import { formatUnifiedDiff } from "./diffFormat";
import { mutate } from "./mutate";
import { resolveInProject } from "./paths";
import { refusalForReadStatus } from "./readTracker";
import type { ToolCtx, ToolResult } from "./types";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);

// docs/TOOL_LAYER_PLAN.md §6.7 — catches the classic failure where a model emits a stub with
// "// ... rest of the file unchanged", which is silent, catastrophic, and was previously unguarded.
const SHRINK_GUARD_MIN_LINES = 50;
const SHRINK_GUARD_RATIO = 0.5;

export function createWriteTool(ctx: ToolCtx) {
  return tool({
    description:
      "Create or overwrite a file, scoped to the project directory. Overwriting an existing file " +
      "requires it to have been read first, and refuses (unless overwrite: true) if the new " +
      "content would shrink it by more than half — use `edit` for a targeted change instead.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      content: z.string(),
      overwrite: z.boolean().optional().describe("Required to replace an existing file with substantially less content"),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      mutate(ctx, { name: "write", input, risk: "high", paths: [input.path] }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);
        const existedBefore = existsSync(abs);
        const oldContent = existedBefore ? readFileSync(abs, "utf8") : "";

        if (existedBefore) {
          const status = ctx.reads.status(input.path);
          if (status !== "ok") {
            const msg = refusalForReadStatus(status, input.path);
            return { ok: false, summary: msg, content: msg };
          }
        }

        const oldLines = existedBefore ? oldContent.split("\n").length : 0;
        const newLines = input.content.split("\n").length;
        if (existedBefore && oldLines > SHRINK_GUARD_MIN_LINES && newLines < oldLines * SHRINK_GUARD_RATIO && !input.overwrite) {
          const pct = Math.round((1 - newLines / oldLines) * 100);
          const msg =
            `Refused: this would shrink ${input.path} from ${oldLines} lines to ${newLines} (−${pct}%).\n` +
            "If you meant to make a targeted change, use `edit`. If you really mean to replace the whole file, pass overwrite: true.";
          return { ok: false, summary: `refused: would shrink ${input.path} by ${pct}%`, content: msg };
        }

        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, input.content);

        // docs/TOOL_LAYER_PLAN.md §6.6/TL5 postcondition, same as edit — the model sees a type
        // error it just introduced in this same result instead of discovering it later.
        const diagnostics = await ctx.diagnostics.fast([input.path]);
        const diagnosticsNote = diagnostics.length
          ? `\n\n${diagnostics.length} new diagnostic${diagnostics.length === 1 ? "" : "s"}:\n${diagnostics.map((d) => `  ${d.file}:${d.line}  ${d.severity}  ${d.code ? `${d.code}: ` : ""}${d.message}`).join("\n")}`
          : "";
        const diagnosticsMeta = diagnostics.length ? { diagnostics } : {};

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
          return {
            ok: true,
            content: `${text}${diagnosticsNote}`,
            summary: `+${added} −${removed}`,
            artifactId: artifact.id,
            meta: { filesWritten: [input.path], ...diagnosticsMeta },
          };
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
        return {
          ok: true,
          content: `${input.content}${diagnosticsNote}`,
          summary: `created · ${lines} lines`,
          artifactId: artifact.id,
          meta: { filesWritten: [input.path], ...diagnosticsMeta },
        };
      }),
  });
}
