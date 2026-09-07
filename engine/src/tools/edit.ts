import { readFileSync, writeFileSync } from "node:fs";
import { tool } from "ai";
import { z } from "zod";
import { createArtifact } from "../db/artifacts";
import { formatUnifiedDiff } from "./diffFormat";
import { mutate } from "./mutate";
import { applyEdits, type PatchOutcome } from "./patch";
import { resolveInProject } from "./paths";
import { refusalForReadStatus } from "./readTracker";
import type { ToolCtx, ToolResult } from "./types";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

// docs/TOOL_LAYER_PLAN.md §6.6 — the model needs to see what's actually there, not just that it
// failed. Only `not_unique`'s occurrence count and `not_found`'s nearest region are structured;
// everything else is prose because there's nothing more to say.
function formatEditFailure(path: string, totalEdits: number, outcome: PatchOutcome): string {
  const f = outcome.failure!;
  const lines = ["No edit applied (edits are atomic).", ""];

  if (f.reason === "empty_old_string") {
    lines.push(`edit ${f.index + 1} of ${totalEdits} failed: oldString is empty.`);
  } else if (f.reason === "not_unique") {
    lines.push(`edit ${f.index + 1} of ${totalEdits} failed: oldString appears ${f.occurrences} times in ${path} — not unique.`);
    lines.push("Pass replaceAll, or add more surrounding context to make it unique.");
  } else {
    lines.push(`edit ${f.index + 1} of ${totalEdits} failed: oldString not found in ${path}`);
    if (f.nearest) {
      lines.push("", `Nearest match at line ${f.nearest.line}:`, "", `  ${f.nearest.line}| ${f.nearest.excerpt}`);
    }
    lines.push("", "Re-read the file or adjust your oldString — never copy read's line-number gutter into it.");
  }

  return lines.join("\n");
}

export function createEditTool(ctx: ToolCtx) {
  return tool({
    description:
      "Replace exact text in a file with new text, scoped to the project directory. Applies a " +
      "list of edits to that one file atomically — if any edit fails, none are written. Requires " +
      "the file to have been read (by `read`, this chat, not changed on disk since) — read it first.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      edits: z
        .array(
          z.object({
            oldString: z.string().describe("Exact text to replace. Never include read's line-number gutter."),
            newString: z.string(),
            replaceAll: z.boolean().optional(),
          }),
        )
        .min(1)
        .describe("Applied in order, atomically — if any edit fails, none are written."),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      mutate(ctx, { name: "edit", input, risk: "high", paths: [input.path] }, async () => {
        const status = ctx.reads.status(input.path);
        if (status !== "ok") {
          const msg = refusalForReadStatus(status, input.path);
          return { ok: false, summary: msg, content: msg };
        }

        const abs = resolveInProject(ctx.projectPath, input.path);
        let original: string;
        try {
          original = readFileSync(abs, "utf8");
        } catch (err) {
          if (isEnoent(err)) {
            const msg = `no such file: ${input.path}`;
            return { ok: false, summary: msg, content: msg };
          }
          throw err;
        }

        const outcome = applyEdits(original, input.edits);
        if (!outcome.ok || outcome.content === undefined) {
          const msg = formatEditFailure(input.path, input.edits.length, outcome);
          return { ok: false, summary: msg.split("\n")[0]!, content: msg };
        }

        writeFileSync(abs, outcome.content);

        const { text, added, removed } = formatUnifiedDiff(original, outcome.content);
        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "diff",
          name: input.path,
          meta: { added, removed },
          body: text,
        });

        // docs/TOOL_LAYER_PLAN.md §6.6 postcondition — surfaced in this same result so the model
        // fixes it in the next step instead of discovering it ten steps later (T7).
        const diagnostics = await ctx.diagnostics.fast([input.path]);
        const diagnosticsNote = diagnostics.length
          ? `\n\n${diagnostics.length} new diagnostic${diagnostics.length === 1 ? "" : "s"}:\n${diagnostics.map((d) => `  ${d.file}:${d.line}  ${d.severity}  ${d.code ? `${d.code}: ` : ""}${d.message}`).join("\n")}`
          : "";

        const editWord = outcome.applied === 1 ? "edit" : "edits";
        return {
          ok: true,
          content: `${input.path} · ${outcome.applied} ${editWord} applied · +${added} −${removed}\n\n${text}${diagnosticsNote}`,
          summary: `+${added} −${removed}`,
          artifactId: artifact.id,
          meta: { filesWritten: [input.path], ...(diagnostics.length ? { diagnostics } : {}) },
        };
      }),
  });
}
