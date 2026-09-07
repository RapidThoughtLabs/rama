import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { runWithTimeout } from "./procRun";

// docs/TOOL_LAYER_PLAN.md §6.11/§6.12 (TL4) — shared plumbing for `git` (read) and `git_write`.
// Both always run against the project's *real* repo (cwd = projectPath, no --git-dir override) —
// this is deliberately a different git instance than checkpoints/index.ts's shadow repo.
const GIT_TIMEOUT_MS = 15_000;

export interface GitExecResult {
  output: string;
  exitCode: number;
  timedOut: boolean;
}

export async function runGit(projectPath: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitExecResult> {
  return runWithTimeout(["git", ...args], { cwd: projectPath, timeoutMs });
}

export async function isGitRepo(projectPath: string): Promise<boolean> {
  const { exitCode } = await runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
  return exitCode === 0;
}

export const NOT_A_REPO_MESSAGE = "not a git repository — this project directory has no .git";

export interface RepoState {
  detachedHead: boolean;
  midMerge: boolean;
  midRebase: boolean;
}

// Backs git_write's commit refusal ("detached HEAD or mid-rebase/merge") — checked via the same
// files/refs `git status` itself consults, not by re-deriving state from porcelain output, since
// none of the three show up as ordinary changed entries there.
export async function getRepoState(projectPath: string): Promise<RepoState> {
  const [symbolicRef, mergeHead, gitDirRes] = await Promise.all([
    runGit(projectPath, ["symbolic-ref", "-q", "HEAD"]),
    runGit(projectPath, ["rev-parse", "--verify", "-q", "MERGE_HEAD"]),
    runGit(projectPath, ["rev-parse", "--git-dir"]),
  ]);
  const gitDirRaw = gitDirRes.output.trim();
  const gitDir = gitDirRaw ? (isAbsolute(gitDirRaw) ? gitDirRaw : join(projectPath, gitDirRaw)) : null;
  const midRebase = !!gitDir && (existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply")));
  return {
    detachedHead: symbolicRef.exitCode !== 0,
    midMerge: mergeHead.exitCode === 0,
    midRebase,
  };
}

export interface StatusEntry {
  code: string;
  path: string;
}

export interface StatusResult {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  conflicted: string[];
}

// Parses `git status --porcelain=v2 --branch -z` — never the human-readable default format,
// which git explicitly does not guarantee the stability of. -z NUL-terminates every record
// (including the "# branch.*" headers) and, for renames, splits path/origPath into two separate
// NUL-terminated fields instead of tab-joining them into one — see git-status(1) "PORCELAIN
// FORMAT VERSION 2" for the field layout this walks.
export function parseStatusPorcelainV2(raw: string): StatusResult {
  const tokens = raw.split("\0").filter((t) => t.length > 0);
  const result: StatusResult = {
    branch: null,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflicted: [],
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;

    if (t.startsWith("# branch.head ")) {
      const head = t.slice("# branch.head ".length);
      if (head === "(detached)") result.detached = true;
      else result.branch = head;
      continue;
    }
    if (t.startsWith("# branch.upstream ")) {
      result.upstream = t.slice("# branch.upstream ".length);
      continue;
    }
    if (t.startsWith("# branch.ab ")) {
      const m = t.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (m) {
        result.ahead = Number(m[1]);
        result.behind = Number(m[2]);
      }
      continue;
    }
    if (t.startsWith("#")) continue; // branch.oid or any header we don't need

    if (t.startsWith("1 ") || t.startsWith("2 ")) {
      const isRename = t.startsWith("2 ");
      const parts = t.split(" ");
      const XY = parts[1] ?? "..";
      const X = XY[0] ?? ".";
      const Y = XY[1] ?? ".";
      // "1 XY sub mH mI mW hH hI path"          -> 8 leading fields, path is the rest
      // "2 XY sub mH mI mW hH hI Xscore path"    -> 9 leading fields; origPath is the NEXT token
      const path = parts.slice(isRename ? 9 : 8).join(" ");
      const origPath = isRename ? tokens[++i] : undefined;
      const label = origPath ? `${origPath} → ${path}` : path;
      if (X !== ".") result.staged.push({ code: X, path: label });
      if (Y !== ".") result.unstaged.push({ code: Y, path: label });
      continue;
    }

    if (t.startsWith("u ")) {
      // "u XY sub m1 m2 m3 mW h1 h2 h3 path" -> 10 leading fields
      const parts = t.split(" ");
      result.conflicted.push(parts.slice(10).join(" "));
      continue;
    }

    if (t.startsWith("? ")) {
      result.untracked.push(t.slice(2));
      continue;
    }
    // "!" (ignored) never appears — --ignored is not passed.
  }

  return result;
}

export async function getStatus(projectPath: string): Promise<StatusResult> {
  const { output } = await runGit(projectPath, ["status", "--porcelain=v2", "--branch", "-z"]);
  return parseStatusPorcelainV2(output);
}

/** Paths (from `input.paths`) that currently show a staged or unstaged modification — the
 *  precondition for git_write's `restore` guard (§6.12: "restore with uncommitted changes to the
 *  affected paths → refused"). Untracked paths are deliberately excluded: `git restore` doesn't
 *  touch them, so they can never be "affected" by it. */
export async function dirtyPathsAmong(projectPath: string, paths: string[]): Promise<string[]> {
  const status = await getStatus(projectPath);
  const dirty = new Set([...status.staged, ...status.unstaged].map((e) => e.path));
  return paths.filter((p) => dirty.has(p));
}
