import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runWithTimeout } from "../tools/procRun";

// docs/TOOL_LAYER_PLAN.md §5.2 — a shadow git repository that never touches the project's own
// .git (index, HEAD, hooks, history). `--git-dir` points here instead of `<project>/.git`, so
// every plumbing command below operates on a completely separate index and object store, even
// when the project is itself a git repo. `write-tree`/`commit-tree` never touch the working tree
// or HEAD, which is what makes snapshotting safe to call on every mutation.
const CHECKPOINTS_DIRNAME = ".rama/checkpoints.git";
const CHECKPOINTS_REF = "refs/heads/checkpoints";
const RUN_START_REF = "refs/heads/run-start";

export interface Checkpointer {
  /** `add -A` + commit-tree, parented to the previous checkpoint. Returns the commit id. */
  snapshot(label: string, opts?: { runStart?: boolean }): Promise<string>;
  /** Hard-resets the working tree (and shadow index) to a checkpoint id or ref name. */
  restore(id: string): Promise<void>;
  /** Unified diff between a checkpoint and the current working tree — the "what did this run
   *  change" view for the UI. */
  diffSince(id: string): Promise<string>;
}

function gitDirFor(projectPath: string): string {
  return join(projectPath, CHECKPOINTS_DIRNAME);
}

async function runGit(projectPath: string, args: string[], timeoutMs = 15_000): Promise<{ output: string; exitCode: number }> {
  const gitDir = gitDirFor(projectPath);
  return runWithTimeout(["git", `--git-dir=${gitDir}`, `--work-tree=${projectPath}`, ...args], {
    cwd: projectPath,
    timeoutMs,
  });
}

// If the project is itself a git repo, its own `git add -A`/`git_write stage` (real git, not
// this shadow one) has no reason to know `.rama/checkpoints.git` exists and would otherwise
// happily commit its internals as ordinary files — a later checkout/reset in the *real* repo can
// then delete or overwrite parts of the shadow store outright. Written to the real repo's own
// `info/exclude`, never its tracked `.gitignore` — this is local-only and never becomes a diff.
function excludeRamaFromRealRepo(projectPath: string): void {
  const realGitDir = join(projectPath, ".git");
  if (!existsSync(realGitDir) || !statSync(realGitDir).isDirectory()) return;
  const excludePath = join(realGitDir, "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
  if (existing.includes(".rama/")) return;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(excludePath, `${existing}${sep}.rama/\n`);
}

async function ensureInit(projectPath: string): Promise<void> {
  excludeRamaFromRealRepo(projectPath);
  const gitDir = gitDirFor(projectPath);
  if (existsSync(gitDir)) return;
  mkdirSync(dirname(gitDir), { recursive: true });
  await runWithTimeout(["git", `--git-dir=${gitDir}`, `--work-tree=${projectPath}`, "init", "-q"], {
    cwd: projectPath,
    timeoutMs: 15_000,
  });
  // Never let the shadow repo's own object store, or the project's real .git, get swept into a
  // snapshot — this can't rely on the project's own .gitignore (a nested .git isn't normally
  // gitignored, and a project may have no .gitignore at all).
  const excludePath = join(gitDir, "info", "exclude");
  mkdirSync(dirname(excludePath), { recursive: true });
  writeFileSync(excludePath, "/.git/\n/.rama/\n");
  // Commits need an identity; a machine-local one that's never pushed anywhere.
  await runGit(projectPath, ["config", "user.email", "rama@localhost"]);
  await runGit(projectPath, ["config", "user.name", "Rama Checkpoints"]);
}

export function createCheckpointer(projectPath: string): Checkpointer {
  return {
    async snapshot(label, opts) {
      await ensureInit(projectPath);
      await runGit(projectPath, ["add", "-A"]);

      const { output: treeOut, exitCode: treeExit } = await runGit(projectPath, ["write-tree"]);
      if (treeExit !== 0) throw new Error(`checkpoint failed: could not write tree (${treeOut.trim()})`);
      const tree = treeOut.trim();

      const { output: parentOut } = await runGit(projectPath, ["rev-parse", "--verify", "-q", CHECKPOINTS_REF]);
      const parent = parentOut.trim();
      const commitArgs = ["commit-tree", tree, "-m", label || "(checkpoint)"];
      if (parent) commitArgs.push("-p", parent);

      const { output: commitOut, exitCode: commitExit } = await runGit(projectPath, commitArgs);
      if (commitExit !== 0) throw new Error(`checkpoint failed: could not commit (${commitOut.trim()})`);
      const commitId = commitOut.trim();

      await runGit(projectPath, ["update-ref", CHECKPOINTS_REF, commitId]);
      if (opts?.runStart) await runGit(projectPath, ["update-ref", RUN_START_REF, commitId]);
      return commitId;
    },

    async restore(id) {
      await ensureInit(projectPath);
      const { exitCode, output } = await runGit(projectPath, ["read-tree", "--reset", "-u", id]);
      if (exitCode !== 0) throw new Error(`restore failed: ${output.trim()}`);
    },

    async diffSince(id) {
      await ensureInit(projectPath);
      const { output } = await runGit(projectPath, ["diff", id, "--", "."]);
      return output;
    },
  };
}

// Standalone (not part of the per-tool-call Checkpointer) — used by the `/undo` command, which
// restores to the checkpoint taken at the *start* of the most recently started run, undoing
// everything that run did rather than just its last mutation.
export async function undoLastRun(projectPath: string): Promise<{ ok: boolean; message: string }> {
  await ensureInit(projectPath);
  const { output: revOut, exitCode: revExit } = await runGit(projectPath, ["rev-parse", "--verify", "-q", RUN_START_REF]);
  if (revExit !== 0) {
    return { ok: false, message: "nothing to undo — no run has touched this project's files yet" };
  }
  const id = revOut.trim();
  const { exitCode: restoreExit, output: restoreOut } = await runGit(projectPath, ["read-tree", "--reset", "-u", id]);
  if (restoreExit !== 0) {
    return { ok: false, message: `undo failed: ${restoreOut.trim()}` };
  }
  return { ok: true, message: "restored the project files to the state before the last run" };
}
