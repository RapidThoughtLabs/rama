import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import type { CheckKind, CheckSummary } from "../diagnostics";
import { headTailTruncate } from "./truncate";
import type { Diagnostic, ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.13 (TL5) — "machine-checkable feedback beats self-assessment,
// because a model asked 'did that work?' says yes." Not `bash npm test`: resolves the project's
// real commands and returns structured diagnostics, capped and grouped.
const ALL_KINDS: CheckKind[] = ["typecheck", "lint", "test", "build"];
const DEFAULT_KINDS: CheckKind[] = ["typecheck", "lint"];
const MAX_DIAGNOSTICS_SHOWN = 20;
const RAW_FALLBACK_MAX_CHARS = 4_000;

const inputSchema = z.object({
  kinds: z
    .array(z.enum(["typecheck", "lint", "test", "build"]))
    .optional()
    .describe(`Defaults to ${JSON.stringify(DEFAULT_KINDS)}. Add "test" explicitly — it is slow.`),
  path: z.string().optional().describe("Scope the shown results to one file or directory (the underlying command still runs project-wide)"),
});

function countBySeverity(diagnostics: Diagnostic[]): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const d of diagnostics) {
    if (d.severity === "warning") warnings++;
    else errors++;
  }
  return { errors, warnings };
}

function formatHeader(requested: Set<CheckKind>, summary: CheckSummary, diagnostics: Diagnostic[]): string {
  return ALL_KINDS.map((kind) => {
    if (!requested.has(kind)) return `(${kind} not run)`;
    const result = summary.results.find((r) => r.kind === kind);
    if (!result?.ran) return `${kind}: not available`;
    if (result.issueCount === 0) return result.ok ? `${kind}: clean` : `${kind}: failed (no structured output)`;
    const kindDiagnostics = diagnostics.filter((d) => d.source === (kind === "typecheck" ? "tsc" : kind === "lint" ? "eslint" : kind));
    const { errors, warnings } = countBySeverity(kindDiagnostics);
    const parts = [errors > 0 ? `${errors} error${errors === 1 ? "" : "s"}` : null, warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : null].filter(Boolean);
    return `${kind}: ${parts.join(", ") || `${result.issueCount} issue${result.issueCount === 1 ? "" : "s"}`}`;
  }).join(" · ");
}

function formatGrouped(diagnostics: Diagnostic[]): string {
  const capped = diagnostics.slice(0, MAX_DIAGNOSTICS_SHOWN);
  const byFile = new Map<string, Diagnostic[]>();
  for (const d of capped) {
    const list = byFile.get(d.file) ?? [];
    list.push(d);
    byFile.set(d.file, list);
  }
  const blocks: string[] = [];
  for (const [file, ds] of byFile) {
    const lines = ds.map((d) => `  ${String(d.line).padStart(4)}:${d.col ?? 0}  ${d.severity}  ${d.code ? `${d.code}  ` : ""}${d.message}`);
    blocks.push(`${file || "(no file)"}\n${lines.join("\n")}`);
  }
  return blocks.join("\n\n");
}

export function createCheckTool(ctx: ToolCtx) {
  return tool({
    description:
      "Run the project's real typecheck/lint/test/build commands and return structured, capped " +
      "diagnostics — not raw command output. Defaults to typecheck + lint; pass kinds: [\"test\"] " +
      "explicitly since it's slow. Run this before declaring work complete.",
    inputSchema,
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "check", input, risk: "low" }, async () => {
        const kinds = input.kinds ?? DEFAULT_KINDS;
        const requested = new Set(kinds);
        const { diagnostics, summary, raw } = await ctx.diagnostics.full(kinds);

        const scoped = input.path ? diagnostics.filter((d) => d.file.startsWith(input.path!)) : diagnostics;
        const header = formatHeader(requested, summary, diagnostics);
        const grouped = formatGrouped(scoped);
        const rawBlocks = Object.entries(raw).map(([kind, text]) => {
          const { content } = headTailTruncate(text as string, RAW_FALLBACK_MAX_CHARS);
          return `${kind}: could not parse structured output — raw output:\n${content}`;
        });

        const content = [header, grouped, ...rawBlocks].filter(Boolean).join("\n\n") || header;
        const allClean = summary.results.every((r) => !r.ran || (r.ok && r.issueCount === 0));

        return {
          ok: allClean,
          content,
          summary: header,
          meta: {
            diagnostics,
            ...(scoped.length > MAX_DIAGNOSTICS_SHOWN || scoped.length !== diagnostics.length
              ? { truncated: { shown: Math.min(scoped.length, MAX_DIAGNOSTICS_SHOWN), total: diagnostics.length, unit: "matches" as const, how: "narrow with path, or scope kinds to just what you need" } }
              : {}),
          },
        };
      }),
  });
}
