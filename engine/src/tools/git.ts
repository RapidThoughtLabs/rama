import { defineTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { resolveInProject } from "./paths";
import { getStatus, isGitRepo, NOT_A_REPO_MESSAGE, runGit } from "./gitShared";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.11 — the read half of native git. Every op is low-risk, parallel-
// safe, and offline (§1). "hunks: false" by default on `diff` is the point of the tool: a raw
// `git diff` over 40 files is thousands of tokens of noise, file list + stats is a few hundred.
const DIFF_HUNKS_MAX_CHARS = 8_000;
const LOG_DEFAULT_LIMIT = 20;
const LOG_UNIT_SEP = "\x1f";
const LOG_RECORD_SEP = "\x1e";
const LOG_FORMAT = `%H${LOG_UNIT_SEP}%h${LOG_UNIT_SEP}%an${LOG_UNIT_SEP}%ad${LOG_UNIT_SEP}%s${LOG_RECORD_SEP}`;

const inputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("status") }),
  z.object({
    op: z.literal("diff"),
    ref: z.string().optional().describe("Compare against this ref instead of the working tree's usual base"),
    staged: z.boolean().optional().describe("Diff the index against HEAD instead of the working tree against the index"),
    path: z.string().optional().describe("Scope to one file or directory"),
    hunks: z.boolean().optional().describe("Default false: file list and stats only. Set true for full hunks — expensive."),
  }),
  z.object({
    op: z.literal("log"),
    path: z.string().optional(),
    ref: z.string().optional(),
    limit: z.number().int().positive().optional().describe(`Defaults to ${LOG_DEFAULT_LIMIT}`),
  }),
  z.object({ op: z.literal("show"), ref: z.string(), path: z.string().optional() }),
  z.object({
    op: z.literal("blame"),
    path: z.string(),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
  }),
]);

function describeAheadBehind(status: Awaited<ReturnType<typeof getStatus>>): string {
  if (!status.upstream) return "no upstream";
  if (status.ahead === 0 && status.behind === 0) return `up to date with ${status.upstream}`;
  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
  if (status.behind > 0) parts.push(`behind ${status.behind}`);
  return `${parts.join(", ")} of ${status.upstream}`;
}

async function formatStatus(projectPath: string): Promise<ToolResult> {
  const status = await getStatus(projectPath);
  const branchLine = status.detached ? "detached HEAD" : `on ${status.branch ?? "(unknown branch)"}`;
  const counts = [
    `${status.staged.length} staged`,
    `${status.unstaged.length} unstaged`,
    `${status.untracked.length} untracked`,
    ...(status.conflicted.length ? [`${status.conflicted.length} conflicted`] : []),
  ].join(" · ");

  const section = (title: string, entries: string[]) => (entries.length ? `\n\n${title}:\n${entries.join("\n")}` : "");

  const content =
    `${branchLine} — ${describeAheadBehind(status)}\n${counts}` +
    section(
      "staged",
      status.staged.map((e) => `  ${e.code}  ${e.path}`),
    ) +
    section(
      "unstaged",
      status.unstaged.map((e) => `  ${e.code}  ${e.path}`),
    ) +
    section("untracked", status.untracked.map((p) => `  ${p}`)) +
    section("conflicted", status.conflicted.map((p) => `  ${p}`));

  const dirty = status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;
  return { ok: true, content, summary: dirty === 0 ? "clean" : `${dirty} changed` };
}

async function formatDiff(
  projectPath: string,
  input: Extract<z.infer<typeof inputSchema>, { op: "diff" }>,
): Promise<ToolResult> {
  if (input.path) resolveInProject(projectPath, input.path); // throws if it escapes the project

  const base = ["diff"];
  if (input.staged) base.push("--cached");
  if (input.ref) base.push(input.ref);

  if (!input.hunks) {
    const { output } = await runGit(projectPath, [...base, "--numstat", "--", ...(input.path ? [input.path] : [])]);
    const rows = output
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [added, removed, ...rest] = line.split("\t");
        return { added, removed, path: rest.join("\t") };
      });

    if (rows.length === 0) return { ok: true, content: "no differences", summary: "no differences" };

    let totalAdded = 0;
    let totalRemoved = 0;
    const lines = rows.map((r) => {
      const a = Number(r.added);
      const rm = Number(r.removed);
      if (!Number.isNaN(a)) totalAdded += a;
      if (!Number.isNaN(rm)) totalRemoved += rm;
      const stat = Number.isNaN(a) || Number.isNaN(rm) ? "(binary)" : `+${a} −${rm}`;
      return `  ${r.path}  ${stat}`;
    });

    const header = `${rows.length} file${rows.length === 1 ? "" : "s"} changed, +${totalAdded} −${totalRemoved}`;
    return { ok: true, content: `${header}\n\n${lines.join("\n")}`, summary: header };
  }

  const { output } = await runGit(projectPath, [...base, "--", ...(input.path ? [input.path] : [])]);
  if (!output.trim()) return { ok: true, content: "no differences", summary: "no differences" };
  const { content, truncated } = headTailTruncate(output, DIFF_HUNKS_MAX_CHARS);
  return {
    ok: true,
    content,
    summary: `diff${input.path ? ` · ${input.path}` : ""}`,
    meta: truncated
      ? { truncated: { shown: DIFF_HUNKS_MAX_CHARS, total: output.length, unit: "bytes", how: "pass hunks:false for the compact summary, or path to scope to one file" } }
      : undefined,
  };
}

async function formatLog(
  projectPath: string,
  input: Extract<z.infer<typeof inputSchema>, { op: "log" }>,
): Promise<ToolResult> {
  if (input.path) resolveInProject(projectPath, input.path);
  const limit = input.limit ?? LOG_DEFAULT_LIMIT;
  const args = ["log", `--format=${LOG_FORMAT}`, "--date=short", "-n", String(limit)];
  if (input.ref) args.push(input.ref);
  args.push("--", ...(input.path ? [input.path] : []));

  const { output, exitCode } = await runGit(projectPath, args);
  if (exitCode !== 0) return { ok: false, summary: "git log failed", content: output.trim() || "git log failed" };

  const records = output.split(LOG_RECORD_SEP).map((r) => r.trim()).filter(Boolean);
  if (records.length === 0) return { ok: true, content: "no commits", summary: "no commits" };

  const lines = records.map((r) => {
    const [, short, author, date, subject] = r.split(LOG_UNIT_SEP);
    return `${short}  ${date}  ${author}\n  ${subject}`;
  });

  return { ok: true, content: `${records.length} commit${records.length === 1 ? "" : "s"}\n\n${lines.join("\n\n")}`, summary: `${records.length} commits` };
}

async function formatShow(
  projectPath: string,
  input: Extract<z.infer<typeof inputSchema>, { op: "show" }>,
): Promise<ToolResult> {
  if (input.path) resolveInProject(projectPath, input.path);

  const meta = await runGit(projectPath, ["show", "-s", `--format=${LOG_FORMAT}`, "--date=short", input.ref]);
  if (meta.exitCode !== 0) return { ok: false, summary: "git show failed", content: meta.output.trim() || "git show failed" };
  const [, short, author, date, subject] = meta.output.split(LOG_RECORD_SEP)[0]!.split(LOG_UNIT_SEP);
  const header = `${short}  ${date}  ${author}\n${subject}`;

  const diffArgs = input.path ? ["show", input.ref, "--", input.path] : ["show", "--stat", input.ref];
  const diff = await runGit(projectPath, diffArgs);
  const { content: diffContent, truncated } = headTailTruncate(diff.output.trim(), DIFF_HUNKS_MAX_CHARS);

  return {
    ok: true,
    content: `${header}\n\n${diffContent}`,
    summary: subject ?? short,
    meta: truncated ? { truncated: { shown: DIFF_HUNKS_MAX_CHARS, total: diff.output.length, unit: "bytes", how: "pass path to scope to one file" } } : undefined,
  };
}

interface BlameRow {
  line: number;
  sha: string;
  author: string;
  date: string;
  content: string;
}

// git-blame(1) --porcelain: a header line per source line ("<sha> <origLine> <finalLine>
// [<numLines>]"), full metadata only the first time a commit is seen, then a "\t<content>" line.
// Deliberately not --line-porcelain (repeats full metadata on every line) — this is the same
// dataset, cheaper to parse, and both are equally "not scraping the human-readable default".
function parseBlamePorcelain(raw: string): BlameRow[] {
  const lines = raw.split("\n");
  const metaBySha = new Map<string, { author: string; date: string }>();
  const rows: BlameRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = lines[i];
    if (header === undefined || header.length === 0) {
      i++;
      continue;
    }
    const m = header.match(/^([0-9a-f]{40}) \d+ (\d+)/);
    if (!m) {
      i++;
      continue;
    }
    const sha = m[1]!;
    const finalLine = Number(m[2]);
    i++;

    let meta = metaBySha.get(sha);
    if (!meta) meta = { author: "", date: "" };
    while (i < lines.length && !lines[i]!.startsWith("\t")) {
      const line = lines[i]!;
      if (line.startsWith("author ")) meta.author = line.slice("author ".length);
      else if (line.startsWith("author-time ")) {
        const ts = Number(line.slice("author-time ".length));
        if (!Number.isNaN(ts)) meta.date = new Date(ts * 1000).toISOString().slice(0, 10);
      }
      i++;
    }
    metaBySha.set(sha, meta);

    const contentLine = lines[i] ?? "";
    rows.push({ line: finalLine, sha: sha.slice(0, 7), author: meta.author, date: meta.date, content: contentLine.slice(1) });
    i++;
  }

  return rows;
}

async function formatBlame(
  projectPath: string,
  input: Extract<z.infer<typeof inputSchema>, { op: "blame" }>,
): Promise<ToolResult> {
  resolveInProject(projectPath, input.path);
  const args = ["blame", "--porcelain"];
  if (input.startLine && input.endLine) args.push("-L", `${input.startLine},${input.endLine}`);
  args.push("--", input.path);

  const { output, exitCode } = await runGit(projectPath, args);
  if (exitCode !== 0) return { ok: false, summary: "git blame failed", content: output.trim() || "git blame failed" };

  const rows = parseBlamePorcelain(output);
  if (rows.length === 0) return { ok: true, content: "(no lines)", summary: "no lines" };

  const authorWidth = Math.min(12, Math.max(...rows.map((r) => r.author.length)));
  const lines = rows.map((r) => `  ${String(r.line).padStart(5)}  ${r.sha}  ${r.date}  ${r.author.slice(0, authorWidth).padEnd(authorWidth)}  ${r.content}`);

  return {
    ok: true,
    content: `${input.path} (lines ${rows[0]!.line}-${rows[rows.length - 1]!.line})\n\n${lines.join("\n")}`,
    summary: `${rows.length} lines`,
  };
}

export function createGitTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "Inspect the project's git repository: status, diff, log, show, blame. Read-only and never " +
      "touches the network. diff defaults to hunks:false (file list + stats only) — pass hunks:true " +
      "only for the files you actually need to see the changes in, it costs far more. Prefer this " +
      "over `bash git ...` for anything this tool covers.",
    inputSchema,
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "git", input, risk: "low" }, async () => {
        if (!(await isGitRepo(ctx.projectPath))) {
          return { ok: false, summary: "not a git repo", content: NOT_A_REPO_MESSAGE };
        }
        switch (input.op) {
          case "status":
            return formatStatus(ctx.projectPath);
          case "diff":
            return formatDiff(ctx.projectPath, input);
          case "log":
            return formatLog(ctx.projectPath, input);
          case "show":
            return formatShow(ctx.projectPath, input);
          case "blame":
            return formatBlame(ctx.projectPath, input);
        }
      }),
  });
}
