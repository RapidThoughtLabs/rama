import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import { listProjectFiles } from "./projectFiles";
import { levenshtein } from "./textSimilarity";
import type { ToolCtx, ToolResult } from "./types";

const MAX_LINES = 4000;
const NEAREST_MATCH_MAX_SCORE = 4;
const NEAREST_MATCH_LIMIT = 3;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".tiff": "image/tiff",
};

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// T3 — "did you mean X" instead of a bare ENOENT. Scores every project file's basename against
// the query's, with a bonus for a directory segment matching the query's stem (so a typo'd
// "src/util.ts" surfaces both "src/utils.ts" and "src/util/index.ts").
async function suggestNearestPaths(projectPath: string, relPath: string): Promise<string[]> {
  const files = await listProjectFiles(projectPath);
  const queryBase = basename(relPath).toLowerCase();
  const queryStem = queryBase.replace(/\.[^.]+$/, "");

  const scored = files.map((f) => {
    const base = basename(f).toLowerCase();
    const segments = f.toLowerCase().split("/");
    const segmentBonus = segments.includes(queryStem) ? -3 : 0;
    return { path: f, score: levenshtein(base, queryBase) + segmentBonus };
  });
  scored.sort((a, b) => a.score - b.score);
  return scored.filter((s) => s.score <= NEAREST_MATCH_MAX_SCORE).slice(0, NEAREST_MATCH_LIMIT).map((s) => s.path);
}

export function createReadTool(ctx: ToolCtx) {
  return tool({
    description:
      "Read a file's contents, scoped to the project directory. Each line is prefixed with a " +
      '"NNNN| " line number for display only — never copy that gutter into edit\'s oldString, it ' +
      `will not match the file's real bytes. Defaults to the first ${MAX_LINES} lines; pass offset/limit to page ` +
      "through longer files. Do not use `bash cat` — it does not mark the file as read, and `edit` will refuse afterwards.",
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      offset: z.number().int().nonnegative().optional().describe("0-based line number to start from; defaults to 0"),
      limit: z.number().int().positive().optional().describe(`Max lines to return; defaults to ${MAX_LINES}`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "read", input, risk: "low" }, async () => {
        const abs = resolveInProject(ctx.projectPath, input.path);

        let stat;
        try {
          stat = statSync(abs);
        } catch (err) {
          if (isEnoent(err)) {
            const suggestions = await suggestNearestPaths(ctx.projectPath, input.path);
            const content = suggestions.length
              ? `not found: ${input.path} — did you mean ${suggestions.join(", ")}?`
              : `not found: ${input.path}`;
            return { ok: false, summary: content, content };
          }
          throw err;
        }

        if (stat.isDirectory()) {
          const content = `${input.path} is a directory — use tree to list its contents`;
          return { ok: false, summary: content, content };
        }

        const buf = readFileSync(abs);
        if (looksBinary(buf)) {
          const size = formatSize(buf.length);
          const mime = IMAGE_MIME[extname(input.path).toLowerCase()];
          const content = mime
            ? `[image · ${size} · ${mime} — this model cannot view images]`
            : `[binary · ${size} · ${mime ?? "application/octet-stream"}]`;
          return {
            ok: true,
            content,
            summary: mime ? `image (${size})` : `binary (${size})`,
            meta: { filesRead: [{ path: input.path, mtimeMs: stat.mtimeMs, size: stat.size }] },
          };
        }

        const raw = buf.toString("utf8");
        const allLines = raw.split("\n");
        const offset = input.offset ?? 0;
        const limit = input.limit ?? MAX_LINES;
        const slice = allLines.slice(offset, offset + limit);
        const truncated = offset + slice.length < allLines.length;

        const content = slice.length
          ? slice.map((line, i) => `${String(offset + i + 1).padStart(4)}| ${line}`).join("\n")
          : "(empty file)";

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "code",
          name: input.path,
          meta: { lines: allLines.length },
          body: raw,
        });

        const shownRange = slice.length ? `${offset + 1}-${offset + slice.length}` : "0";
        return {
          ok: true,
          content,
          summary: `${shownRange} of ${allLines.length} lines`,
          artifactId: artifact.id,
          meta: {
            filesRead: [{ path: input.path, mtimeMs: stat.mtimeMs, size: stat.size }],
            ...(truncated
              ? {
                  truncated: {
                    shown: slice.length,
                    total: allLines.length,
                    unit: "lines" as const,
                    how: `pass offset:${offset + slice.length} to continue reading`,
                  },
                }
              : {}),
          },
        };
      }),
  });
}
