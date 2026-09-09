import { defineTool } from "./define";
import { z } from "zod";
import { mutate } from "./mutate";
import { resolveInProject } from "./paths";
import { dirtyPathsAmong, getRepoState, getStatus, isGitRepo, NOT_A_REPO_MESSAGE, runGit } from "./gitShared";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.12 — the write half of native git. Deliberately absent: push, pull,
// fetch, merge, rebase, reset --hard, clean, commit --amend, anything --force. Remote ops belong
// to the external layer (§7); history-rewriting/hard-reset is what checkpoints (§5.2) are for —
// exposing both here is how a model ends up choosing the destructive one.
const inputSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("stage"), paths: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("unstage"), paths: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("commit"), message: z.string().min(1), stageAll: z.boolean().optional() }),
  z.object({ op: z.literal("branch"), name: z.string().min(1), from: z.string().optional() }),
  z.object({ op: z.literal("checkout"), ref: z.string().min(1) }),
  z.object({ op: z.literal("restore"), paths: z.array(z.string()).min(1) }),
  z.object({ op: z.literal("stash"), pop: z.boolean().optional() }),
]);

function pathsFor(input: z.infer<typeof inputSchema>): string[] {
  if (input.op === "stage" || input.op === "unstage" || input.op === "restore") return input.paths;
  return [];
}

// The repo's commit-message policy (~/.claude/CLAUDE.md: no co-authorship trailer) enforced
// mechanically rather than left to the system prompt — "a policy the harness can enforce
// mechanically should not be left to the prompt" (§6.12).
function stripCoAuthoredBy(message: string): string {
  const stripped = message
    .split("\n")
    .filter((line) => !/^co-authored-by:/i.test(line.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return stripped.length > 0 ? stripped : message.trim();
}

// git's own safety check (`checkout` refuses when it would clobber uncommitted changes) is more
// precise than anything reimplemented here — this just translates its stderr into something the
// model can act on rather than surfacing the raw multi-line error verbatim.
function extractOverwrittenPaths(output: string): string[] {
  const lines = output.split("\n");
  const paths: string[] = [];
  let capturing = false;
  for (const line of lines) {
    if (/would be overwritten by (checkout|merge)/.test(line)) {
      capturing = true;
      continue;
    }
    if (!capturing) continue;
    if (/^\s+\S/.test(line)) {
      paths.push(line.trim());
      continue;
    }
    break;
  }
  return paths;
}

async function runStage(projectPath: string, paths: string[]): Promise<ToolResult> {
  for (const p of paths) resolveInProject(projectPath, p);
  const { output, exitCode } = await runGit(projectPath, ["add", "--", ...paths]);
  if (exitCode !== 0) return { ok: false, summary: "git add failed", content: output.trim() || "git add failed" };
  return { ok: true, content: `staged ${paths.join(", ")}`, summary: "staged", meta: { filesWritten: [] } };
}

async function runUnstage(projectPath: string, paths: string[]): Promise<ToolResult> {
  for (const p of paths) resolveInProject(projectPath, p);
  const { output, exitCode } = await runGit(projectPath, ["restore", "--staged", "--", ...paths]);
  if (exitCode !== 0) return { ok: false, summary: "git restore --staged failed", content: output.trim() || "unstage failed" };
  return { ok: true, content: `unstaged ${paths.join(", ")}`, summary: "unstaged", meta: { filesWritten: [] } };
}

async function runCommit(projectPath: string, message: string, stageAll?: boolean): Promise<ToolResult> {
  const state = await getRepoState(projectPath);
  if (state.detachedHead) {
    return { ok: false, summary: "refused: detached HEAD", content: "Refused: HEAD is detached — a commit here won't belong to any branch. Create a branch first (git_write branch) if you want to keep it." };
  }
  if (state.midMerge) {
    return { ok: false, summary: "refused: merge in progress", content: "Refused: a merge is in progress (MERGE_HEAD exists). Resolve the conflicts and finish the merge (or abort it) before committing." };
  }
  if (state.midRebase) {
    return { ok: false, summary: "refused: rebase in progress", content: "Refused: a rebase is in progress. Resolve it (continue or abort) before committing." };
  }

  if (stageAll) {
    const addResult = await runGit(projectPath, ["add", "-A"]);
    if (addResult.exitCode !== 0) return { ok: false, summary: "git add -A failed", content: addResult.output.trim() || "git add -A failed" };
  }

  const staged = await runGit(projectPath, ["diff", "--cached", "--quiet"]);
  if (staged.exitCode === 0) {
    const status = await getStatus(projectPath);
    const dirty = [...status.unstaged.map((e) => `  ${e.code}  ${e.path}`), ...status.untracked.map((p) => `  ?  ${p}`)];
    const detail = dirty.length ? `\n\nCurrent changes (none staged):\n${dirty.join("\n")}` : "\n\nThe working tree is clean.";
    return {
      ok: false,
      summary: "refused: nothing staged",
      content: `Refused: nothing is staged to commit.${detail}\n\nPass stageAll: true, or stage specific paths first with { op: "stage" }.`,
    };
  }

  const cleanMessage = stripCoAuthoredBy(message);
  const { output, exitCode } = await runGit(projectPath, ["commit", "-m", cleanMessage]);
  if (exitCode !== 0) return { ok: false, summary: "git commit failed", content: output.trim() || "git commit failed" };
  return { ok: true, content: output.trim(), summary: "committed", meta: { filesWritten: [] } };
}

async function runBranch(projectPath: string, name: string, from?: string): Promise<ToolResult> {
  const args = ["branch", name];
  if (from) args.push(from);
  const { output, exitCode } = await runGit(projectPath, args);
  if (exitCode !== 0) return { ok: false, summary: "git branch failed", content: output.trim() || "git branch failed" };
  return { ok: true, content: `created branch ${name}${from ? ` from ${from}` : ""}`, summary: "branch created", meta: { filesWritten: [] } };
}

async function runCheckout(projectPath: string, ref: string): Promise<ToolResult> {
  const { output, exitCode } = await runGit(projectPath, ["checkout", ref]);
  if (exitCode === 0) return { ok: true, content: output.trim() || `switched to ${ref}`, summary: `on ${ref}`, meta: { filesWritten: [] } };

  const overwritten = extractOverwrittenPaths(output);
  if (overwritten.length > 0) {
    return {
      ok: false,
      summary: "refused: would overwrite uncommitted changes",
      content: `Refused: switching to "${ref}" would overwrite uncommitted changes in:\n${overwritten.map((p) => `  ${p}`).join("\n")}\n\nCommit them, or stash them first ({ op: "stash" }).`,
    };
  }
  return { ok: false, summary: "git checkout failed", content: output.trim() || "git checkout failed" };
}

async function runRestore(projectPath: string, paths: string[]): Promise<ToolResult> {
  for (const p of paths) resolveInProject(projectPath, p);
  const dirty = await dirtyPathsAmong(projectPath, paths);
  if (dirty.length > 0) {
    return {
      ok: false,
      summary: "refused: uncommitted changes",
      content: `Refused: restoring would discard uncommitted changes in:\n${dirty.map((p) => `  ${p}`).join("\n")}\n\nStash them first ({ op: "stash" }) if you want to keep them, then restore.`,
    };
  }
  const { output, exitCode } = await runGit(projectPath, ["restore", "--", ...paths]);
  if (exitCode !== 0) return { ok: false, summary: "git restore failed", content: output.trim() || "git restore failed" };
  return { ok: true, content: `restored ${paths.join(", ")}`, summary: "restored", meta: { filesWritten: paths } };
}

async function runStash(projectPath: string, pop?: boolean): Promise<ToolResult> {
  const args = pop ? ["stash", "pop"] : ["stash", "push"];
  const { output, exitCode } = await runGit(projectPath, args);
  if (exitCode !== 0) return { ok: false, summary: `git stash ${pop ? "pop" : "push"} failed`, content: output.trim() || "git stash failed" };
  return { ok: true, content: output.trim() || (pop ? "stash popped" : "changes stashed"), summary: pop ? "stash popped" : "stashed", meta: { filesWritten: [] } };
}

export function createGitWriteTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "Mutate the project's git repository: stage/unstage, commit, branch, checkout, restore, " +
      "stash. No push/pull/fetch/merge/rebase, no --force, no reset --hard or commit --amend — " +
      "those are either the external layer's business or what checkpoints/undo exist for. commit " +
      "refuses with nothing staged (unless stageAll), on a detached HEAD, or mid-rebase/merge. " +
      "restore refuses if the paths have uncommitted changes (stash first). checkout refuses if " +
      "it would overwrite uncommitted changes. Prefer this over `bash git ...` for anything it covers.",
    inputSchema,
    execute: async (input): Promise<ToolResult> =>
      mutate(ctx, { name: "git_write", input, risk: "high", paths: pathsFor(input) }, async () => {
        if (!(await isGitRepo(ctx.projectPath))) {
          return { ok: false, summary: "not a git repo", content: NOT_A_REPO_MESSAGE };
        }
        switch (input.op) {
          case "stage":
            return runStage(ctx.projectPath, input.paths);
          case "unstage":
            return runUnstage(ctx.projectPath, input.paths);
          case "commit":
            return runCommit(ctx.projectPath, input.message, input.stageAll);
          case "branch":
            return runBranch(ctx.projectPath, input.name, input.from);
          case "checkout":
            return runCheckout(ctx.projectPath, input.ref);
          case "restore":
            return runRestore(ctx.projectPath, input.paths);
          case "stash":
            return runStash(ctx.projectPath, input.pop);
        }
      }),
  });
}
