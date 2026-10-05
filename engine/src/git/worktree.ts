import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { RAMA_HOME } from "../db/index";
import { runGit } from "../tools/gitShared";

// docs/COMPOSER_CONTEXT_PLAN.md Phase CC2 — real git-worktree isolation per chat. Lives under
// ~/.rama/worktrees, outside the project's own tree entirely (unlike checkpoints/index.ts's
// shadow repo, which deliberately lives *inside* the project as `.rama/checkpoints.git`) — a
// worktree checkout should never show up in the primary checkout's own status/diff or need
// excluding from it.
const WORKTREES_ROOT = join(RAMA_HOME, "worktrees");
const WORKTREE_TIMEOUT_MS = 30_000;

function worktreePathFor(projectId: string, chatId: string): string {
  return join(WORKTREES_ROOT, projectId, chatId);
}

// One dedicated branch per chat, deterministic from the chat id — this is what makes "two chats
// wanting a worktree off the same branch" (docs/COMPOSER_CONTEXT_PLAN.md CC2's open question) a
// non-issue by construction: no two chats can ever name the same branch.
function branchNameFor(chatId: string): string {
  return `rama/${chatId}`;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

// Idempotent — checking the CC0 box again on a chat that already has one just returns it.
// Branches off whatever HEAD the primary checkout is on right now (not projectRow.defaultBranch):
// "isolate this chat's work" reads most naturally as "start from where I am," not "always restart
// from main."
export async function ensureWorktree(projectPath: string, projectId: string, chatId: string): Promise<WorktreeInfo> {
  const path = worktreePathFor(projectId, chatId);
  const branch = branchNameFor(chatId);
  if (existsSync(path)) return { path, branch };

  mkdirSync(join(WORKTREES_ROOT, projectId), { recursive: true });

  const branchExists = (await runGit(projectPath, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`])).exitCode === 0;
  const args = branchExists ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path];
  const { exitCode, output } = await runGit(projectPath, args, WORKTREE_TIMEOUT_MS);
  if (exitCode !== 0) throw new Error(`git worktree add failed: ${output.trim() || `exit ${exitCode}`}`);

  return { path, branch };
}

// Best-effort by design: called both from the CC0 checkbox (uncheck) and from chat deletion, and
// neither of those should fail the user-visible action over a worktree that git can't cleanly
// remove (e.g. uncommitted changes inside it, or the directory already gone). Falls back to
// deleting the directory and letting a later `git worktree prune` reconcile the metadata.
export async function removeWorktree(projectPath: string, projectId: string, chatId: string): Promise<void> {
  const path = worktreePathFor(projectId, chatId);
  if (!existsSync(path)) return;

  const { exitCode } = await runGit(projectPath, ["worktree", "remove", "--force", path], WORKTREE_TIMEOUT_MS);
  if (exitCode !== 0) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // orphaned worktree metadata is a `git worktree prune` away from clean — not worth
      // failing the caller over.
    }
  }
  await runGit(projectPath, ["worktree", "prune"]).catch(() => {});
}
