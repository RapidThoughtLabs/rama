import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { resolveInProject } from "./paths";
import { EXCLUDE_DIRS } from "./projectFiles";
import { runWithTimeout } from "./procRun";
import type { ToolCtx, ToolResult } from "./types";

const DEFAULT_LIMIT = 200;
const GROUP_SEP = "--";

// Detected once per process, not per call — a missing `rg` binary throws synchronously from
// Bun.spawn, so this is cached rather than re-attempted on every grep call.
let rgAvailable: boolean | null = null;
async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  try {
    const proc = Bun.spawn({ cmd: ["rg", "--version"], stdout: "ignore", stderr: "ignore" });
    rgAvailable = (await proc.exited) === 0;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

type Mode = "content" | "files" | "count";

function buildArgs(useRg: boolean, input: { pattern: string; caseInsensitive?: boolean; glob?: string; contextLines?: number }, mode: Mode, searchPath: string): string[] {
  if (useRg) {
    const args = ["rg", "--no-messages"];
    if (input.caseInsensitive) args.push("-i");
    if (input.glob) args.push("-g", input.glob);
    for (const dir of EXCLUDE_DIRS) args.push("-g", `!${dir}`);
    if (mode === "files") args.push("--files-with-matches");
    else if (mode === "count") args.push("--count-matches");
    else {
      args.push("--line-number", "--no-heading", "--with-filename");
      if (input.contextLines) args.push("-C", String(input.contextLines));
    }
    args.push(input.pattern, searchPath);
    return args;
  }

  const args = ["grep", "-rn", "-E", ...[...EXCLUDE_DIRS].map((d) => `--exclude-dir=${d}`)];
  if (input.caseInsensitive) args.push("-i");
  if (input.glob) args.push(`--include=${input.glob}`);
  if (mode === "content" && input.contextLines) args.push("-C", String(input.contextLines));
  if (mode === "files") args.push("-l");
  else if (mode === "count") args.push("-c");
  args.push(input.pattern, searchPath);
  return args;
}

// Matches both "file:12:content" (match line) and "file-12-content" (context line) shapes —
// ripgrep and grep both switch the delimiter to "-" for context lines around a match.
function extractFile(line: string): string | null {
  if (line === GROUP_SEP) return null;
  const m = line.match(/^(.+?)[:-]\d+[:-]/);
  return m ? m[1]! : null;
}

export function createGrepTool(ctx: ToolCtx) {
  return tool({
    description:
      "Search file contents for a regex pattern (Rust regex syntax under ripgrep, POSIX ERE " +
      "under the grep fallback), scoped to the project directory. " +
      '"content" mode (default) returns matching lines; "files" returns unique matching file paths; ' +
      '"count" returns a match-count table per file — try "count" first when a pattern may be broad, ' +
      "to narrow before spending context on full matches.",
    inputSchema: z.object({
      pattern: z.string(),
      path: z.string().optional().describe("Path relative to the project root; defaults to the whole project"),
      glob: z.string().optional().describe('Restrict to matching files, e.g. "*.ts"'),
      caseInsensitive: z.boolean().optional(),
      contextLines: z.number().int().nonnegative().optional().describe("Lines of context around each match. Default 0."),
      mode: z.enum(["content", "files", "count"]).optional().describe('Defaults to "content"'),
      limit: z.number().int().positive().optional().describe(`Max matches shown; defaults to ${DEFAULT_LIMIT}`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "grep", input, risk: "low" }, async () => {
        const searchPath = input.path ?? ".";
        resolveInProject(ctx.projectPath, searchPath); // throws if it escapes the project
        const mode: Mode = input.mode ?? "content";
        const limit = input.limit ?? DEFAULT_LIMIT;
        const useRg = await hasRipgrep();

        const { output, exitCode, timedOut } = await runWithTimeout(buildArgs(useRg, input, mode, searchPath), {
          cwd: ctx.projectPath,
          timeoutMs: 10_000,
          abortSignal: ctx.abortSignal,
        });

        if (timedOut) return { ok: false, summary: `grep timed out searching "${input.pattern}"` };
        if (exitCode !== 0 && !output.trim()) {
          const content = `no matches for "${input.pattern}"`;
          return { ok: true, content, summary: content };
        }

        const allLines = output.split("\n").filter(Boolean);

        if (mode === "files") {
          const files = [...new Set(allLines)].sort();
          const shown = files.slice(0, limit);
          return {
            ok: true,
            content: shown.join("\n"),
            summary: `${files.length} file${files.length === 1 ? "" : "s"} matched${files.length > limit ? ` (showing ${limit})` : ""}`,
          };
        }

        if (mode === "count") {
          // rg's --count-matches only emits files with >=1 match; grep -c emits every searched
          // file including zero-match ones, so filter defensively regardless of backend.
          const rows = allLines
            .map((l) => {
              const idx = l.lastIndexOf(":");
              return { file: l.slice(0, idx), count: Number(l.slice(idx + 1)) };
            })
            .filter((r) => r.count > 0)
            .sort((a, b) => b.count - a.count);
          const shown = rows.slice(0, limit);
          const total = rows.reduce((sum, r) => sum + r.count, 0);
          return {
            ok: true,
            content: shown.map((r) => `${String(r.count).padStart(5)}  ${r.file}`).join("\n"),
            summary: `${rows.length} file${rows.length === 1 ? "" : "s"} · ${total} total matches`,
          };
        }

        const fileCount = new Set(allLines.map(extractFile).filter((f): f is string => f !== null)).size;
        const truncated = allLines.length > limit;
        const shown = truncated ? allLines.slice(0, limit) : allLines;
        const content = shown.join("\n");

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "terminal",
          name: `grep "${input.pattern}" ${searchPath}`,
          meta: { matches: allLines.length, files: fileCount },
          body: output,
        });
        return {
          ok: true,
          content,
          summary: `${allLines.length} matches across ${fileCount} file${fileCount === 1 ? "" : "s"}`,
          artifactId: artifact.id,
          meta: truncated
            ? {
                truncated: {
                  shown: shown.length,
                  total: allLines.length,
                  unit: "matches",
                  how: 'narrow the pattern, scope `path`/`glob`, or use mode:"count" to see spread before reading matches',
                },
              }
            : undefined,
        };
      }),
  });
}
