import { statSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { resolveInProject } from "./paths";
import { EXCLUDE_DIRS, listProjectFiles } from "./projectFiles";
import type { ToolCtx, ToolResult } from "./types";

const DEFAULT_LIMIT = 200;

export function createGlobTool(ctx: ToolCtx) {
  return defineTool({
    description:
      'Find files by glob pattern (e.g. "**/*.ts", "src/**/*.test.*"), scoped to the project ' +
      "directory and respecting .gitignore. Results are sorted most-recently-modified first.",
    inputSchema: z.object({
      pattern: z.string().describe('Glob pattern, e.g. "**/*.ts"'),
      path: z.string().optional().describe("Path relative to the project root to search within; defaults to the whole project"),
      limit: z.number().int().positive().optional().describe(`Max results; defaults to ${DEFAULT_LIMIT}`),
    }),
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "glob", input, risk: "low" }, async () => {
        const searchRel = input.path ?? ".";
        const searchAbs = resolveInProject(ctx.projectPath, searchRel);
        const limit = input.limit ?? DEFAULT_LIMIT;
        const matcher = new Bun.Glob(input.pattern);

        const candidates = await listProjectFiles(searchAbs);
        const matches: { path: string; mtimeMs: number }[] = [];
        for (const rel of candidates) {
          if (!matcher.match(rel)) continue;
          if (rel.split("/").some((seg) => EXCLUDE_DIRS.has(seg))) continue;
          try {
            matches.push({ path: rel, mtimeMs: statSync(join(searchAbs, rel)).mtimeMs });
          } catch {
            // raced with a delete between listing and stat — drop it
          }
        }

        matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const total = matches.length;
        const shown = matches.slice(0, limit);
        const truncated = total > limit;

        const content = shown.length ? shown.map((m) => m.path).join("\n") : `no files matched "${input.pattern}"`;

        return {
          ok: true,
          content,
          summary: `${total} file${total === 1 ? "" : "s"} matched${truncated ? ` (showing ${limit} most recent)` : ""}`,
          meta: truncated
            ? {
                truncated: {
                  shown: shown.length,
                  total,
                  unit: "entries",
                  how: `most-recently-modified ${limit} kept; narrow the pattern or path for the rest`,
                },
              }
            : undefined,
        };
      }),
  });
}
