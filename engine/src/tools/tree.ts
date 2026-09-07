import { readdirSync } from "node:fs";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import { EXCLUDE_DIRS, listIgnoredDirs } from "./projectFiles";
import type { ToolCtx, ToolResult } from "./types";

const DEFAULT_DEPTH = 2;
const DEFAULT_LIMIT = 200;

// Recursively counts entries under an ignored directory so it can be collapsed to a count
// instead of either dumping thousands of node_modules lines or silently hiding it.
function countEntriesRecursive(abs: string): number {
  let count = 0;
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      count++;
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  return count;
}

export function createTreeTool(ctx: ToolCtx) {
  return tool({
    description:
      "Show a directory as an indented tree, scoped to the project directory. Gitignored " +
      "directories are collapsed to an entry count rather than expanded. Use for orientation, " +
      "not enumeration — prefer `glob` when you know the name shape you're looking for.",
    inputSchema: z.object({
      path: z.string().optional().describe("Path relative to the project root; defaults to the project root"),
      depth: z.number().int().positive().optional().describe(`Max depth to expand; defaults to ${DEFAULT_DEPTH}`),
      limit: z.number().int().positive().optional().describe(`Max entries shown; defaults to ${DEFAULT_LIMIT}`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "tree", input, risk: "low" }, async () => {
        const relRoot = input.path ?? ".";
        const rootAbs = resolveInProject(ctx.projectPath, relRoot);
        const maxDepth = input.depth ?? DEFAULT_DEPTH;
        const limit = input.limit ?? DEFAULT_LIMIT;
        const ignoredDirs = await listIgnoredDirs(rootAbs);

        const lines: string[] = [];
        let count = 0;
        let truncated = false;
        // Breadth-first so a cap cuts off the deepest/least-explored level rather than
        // exhausting the budget on the first subtree encountered — the shape of the project
        // survives the truncation even when the full contents don't.
        let queue: { relPath: string; depth: number }[] = [{ relPath: "", depth: 0 }];

        while (queue.length && !truncated) {
          const level = queue;
          queue = [];
          for (const dirEntry of level) {
            if (count >= limit) {
              truncated = true;
              break;
            }
            const dirAbs = join(rootAbs, dirEntry.relPath);
            let entries;
            try {
              entries = readdirSync(dirAbs, { withFileTypes: true });
            } catch {
              continue;
            }
            entries.sort((a, b) => {
              if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
              return a.name.localeCompare(b.name);
            });

            const indent = "  ".repeat(dirEntry.depth);
            for (const entry of entries) {
              if (count >= limit) {
                truncated = true;
                break;
              }
              const relChild = dirEntry.relPath ? `${dirEntry.relPath}/${entry.name}` : entry.name;

              if (entry.isDirectory()) {
                const isIgnored = ignoredDirs.has(relChild) || EXCLUDE_DIRS.has(entry.name);
                if (isIgnored) {
                  const n = countEntriesRecursive(join(rootAbs, relChild));
                  lines.push(`${indent}${entry.name}/ (${n.toLocaleString()} entries, ignored)`);
                  count++;
                } else {
                  lines.push(`${indent}${entry.name}/`);
                  count++;
                  if (dirEntry.depth + 1 < maxDepth) queue.push({ relPath: relChild, depth: dirEntry.depth + 1 });
                }
              } else {
                lines.push(`${indent}${entry.name}`);
                count++;
              }
            }
          }
        }

        const body = lines.join("\n") || "(empty directory)";
        const content = `${relRoot === "." ? "." : relRoot}\n${body}`;

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: `tree ${relRoot}`,
          meta: { entries: count },
          body: content,
        });

        return {
          ok: true,
          content,
          summary: `${count} entr${count === 1 ? "y" : "ies"}${truncated ? " (truncated)" : ""}`,
          artifactId: artifact.id,
          meta: truncated
            ? { truncated: { shown: count, total: count, unit: "entries", how: "narrow `path` or lower `depth` for the rest" } }
            : undefined,
        };
      }),
  });
}
