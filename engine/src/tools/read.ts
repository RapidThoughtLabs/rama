import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { defineTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { HOME_PROJECT_ID } from "../db/home";
import { readPdfText } from "../files/pdf";
import { resolveReadPath } from "./paths";
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

// HOME_REDESIGN_PLAN.md HD7 — Home's read is for the files the user attaches, so it gets plain
// wording without the Code-only advice about bash and edit (an HD3 follow-up).
const HOME_DESCRIPTION =
  "Read a file the user attached (its path is given in their message), or another file in your Home " +
  'folder. Each line is prefixed with a "NNNN| " line number for reference. A PDF comes back as its ' +
  'text, with a "--- Page N ---" line before each page. ' +
  `Defaults to the first ${MAX_LINES} lines; pass offset/limit to page through longer files.`;

export function createReadTool(ctx: ToolCtx) {
  return defineTool({
    description: ctx.projectId === HOME_PROJECT_ID ? HOME_DESCRIPTION :
      "Read a file's contents, scoped to the project directory. Each line is prefixed with a " +
      '"NNNN| " line number for display only — never copy that gutter into edit\'s oldString, it ' +
      `will not match the file's real bytes. Defaults to the first ${MAX_LINES} lines; pass offset/limit to page ` +
      "through longer files. Do not use `bash cat` — it does not mark the file as read, and `edit` will refuse afterwards." +
      (ctx.extraRoots.length
        ? ` Also accepts an absolute path under one of this chat's extra context folders: ${ctx.extraRoots.join(", ")} — read-only, edit will refuse there.`
        : ""),
    inputSchema: z.object({
      path: z.string().describe("Path relative to the project root"),
      offset: z.number().int().nonnegative().optional().describe("0-based line number to start from; defaults to 0"),
      limit: z.number().int().positive().optional().describe(`Max lines to return; defaults to ${MAX_LINES}`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "read", input, risk: "low" }, async () => {
        const abs = resolveReadPath(ctx.projectPath, ctx.extraRoots, input.path);

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

        // HD7 — a PDF reads as its extracted text (a Home attachment's sidecar, or extracted now).
        if (extname(abs).toLowerCase() === ".pdf") {
          let pdf;
          try {
            pdf = await readPdfText(abs);
          } catch (err) {
            const content = `couldn't open ${input.path} as a PDF: ${err instanceof Error ? err.message : String(err)}`;
            return { ok: false, summary: `couldn't open ${basename(input.path)}`, content };
          }
          return textResult(ctx, input, options.toolCallId, pdf.text, stat, ` · ${pdf.pages} page${pdf.pages === 1 ? "" : "s"}`);
        }

        const buf = readFileSync(abs);
        if (looksBinary(buf)) {
          const size = formatSize(buf.length);
          const mime = IMAGE_MIME[extname(input.path).toLowerCase()];
          // HD7 — in Home a photo the user attaches already comes with their message when the
          // model can see images, so read only points back there.
          const content = mime
            ? ctx.projectId === HOME_PROJECT_ID
              ? `[photo · ${size} · ${mime} — read can't show images. If the user attached it and you can see images, it's included with their message.]`
              : `[image · ${size} · ${mime} — this model cannot view images]`
            : `[binary · ${size} · ${mime ?? "application/octet-stream"}]`;
          return {
            ok: true,
            content,
            summary: mime ? `image (${size})` : `binary (${size})`,
            meta: { filesRead: [{ path: input.path, mtimeMs: stat.mtimeMs, size: stat.size }] },
          };
        }

        return textResult(ctx, input, options.toolCallId, buf.toString("utf8"), stat);
      }),
  });
}

// A text file's lines, paged by offset/limit. `summarySuffix` carries a PDF's page count
// (" · 14 pages"), which Home's activity row shows instead of the line count.
function textResult(
  ctx: ToolCtx,
  input: { path: string; offset?: number; limit?: number },
  toolCallId: string,
  raw: string,
  stat: { mtimeMs: number; size: number },
  summarySuffix = "",
): ToolResult {
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
    toolCallId,
    kind: "code",
    name: input.path,
    meta: { lines: allLines.length },
    body: raw,
  });

  const shownRange = slice.length ? `${offset + 1}-${offset + slice.length}` : "0";
  return {
    ok: true,
    content,
    summary: `${shownRange} of ${allLines.length} lines${summarySuffix}`,
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
}
