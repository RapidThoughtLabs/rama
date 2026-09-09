import { existsSync, readFileSync } from "node:fs";
import type { ChangeDiffDTO, ChangeEntryDTO, ChangesDTO, ChangeStatus } from "@rama/protocol";
import { getRepoState, getStatus, isGitRepo, runGit } from "../tools/gitShared";
import { resolveInProject } from "../tools/paths";
import { headTailTruncate } from "../tools/truncate";

// docs/WORKSPACE_PANES_PLAN.md §6.1 / §6.3 — Git read API (Phase W3).

interface NumstatRecord {
  added: number | null;
  removed: number | null;
  binary: boolean;
  path: string;
  origPath?: string;
}

function parseNumstatZ(raw: string): Map<string, NumstatRecord> {
  const map = new Map<string, NumstatRecord>();
  const tokens = raw.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (!t) continue;
    const parts = t.split("\t");
    if (parts.length < 3) continue;
    const addStr = parts[0]!;
    const delStr = parts[1]!;
    const binary = addStr === "-" && delStr === "-";
    const added = binary ? null : parseInt(addStr, 10);
    const removed = binary ? null : parseInt(delStr, 10);
    let path = parts.slice(2).join("\t");
    let origPath: string | undefined;

    if (path === "" && i + 2 < tokens.length) {
      origPath = tokens[++i]!;
      path = tokens[++i]!;
    }
    map.set(path, {
      added: isNaN(added as number) ? null : added,
      removed: isNaN(removed as number) ? null : removed,
      binary,
      path,
      origPath,
    });
  }
  return map;
}

async function getUntrackedNumstat(
  projectPath: string,
  untrackedPaths: string[],
): Promise<Map<string, { added: number | null; removed: number | null; binary: boolean }>> {
  const map = new Map<string, { added: number | null; removed: number | null; binary: boolean }>();
  const pathsToProcess = untrackedPaths.slice(0, 200);
  const concurrency = 8;
  let idx = 0;

  async function worker() {
    while (idx < pathsToProcess.length) {
      const currentIdx = idx++;
      const p = pathsToProcess[currentIdx]!;
      try {
        const res = await runGit(projectPath, ["diff", "--no-index", "--numstat", "-z", "--", "/dev/null", p]);
        if (res.exitCode === 0 || res.exitCode === 1) {
          const parsed = parseNumstatZ(res.output);
          const rec = parsed.get(p) ?? Array.from(parsed.values())[0];
          if (rec) {
            map.set(p, { added: rec.added, removed: rec.removed, binary: rec.binary });
          }
        }
      } catch {
        // best-effort
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, pathsToProcess.length); w++) {
    workers.push(worker());
  }
  await Promise.all(workers);

  return map;
}

export async function readChanges(projectPath: string): Promise<ChangesDTO> {
  const isRepo = await isGitRepo(projectPath);
  if (!isRepo) {
    return {
      isRepo: false,
      branch: null,
      detached: false,
      head: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      midMerge: false,
      midRebase: false,
      entries: [],
      countsOmitted: false,
    };
  }

  const [status, repoState, headRes] = await Promise.all([
    getStatus(projectPath),
    getRepoState(projectPath),
    runGit(projectPath, ["rev-parse", "--short", "HEAD"]),
  ]);

  const head = headRes.exitCode === 0 ? headRes.output.trim() : null;

  const totalChanged =
    status.staged.length + status.unstaged.length + status.untracked.length + status.conflicted.length;

  // §6.2 Dirty-repo escape hatch (> 500 changed paths skips numstat pricing)
  if (totalChanged > 500) {
    const entryMap = new Map<string, ChangeEntryDTO>();

    for (const s of status.staged) {
      const arrowIdx = s.path.indexOf(" → ");
      const origPath = arrowIdx !== -1 ? s.path.slice(0, arrowIdx) : null;
      const targetPath = arrowIdx !== -1 ? s.path.slice(arrowIdx + 3) : s.path;
      entryMap.set(targetPath, {
        path: targetPath,
        origPath,
        status: s.code === "A" ? "added" : s.code === "D" ? "deleted" : s.code === "R" || origPath ? "renamed" : "modified",
        staged: true,
        unstaged: false,
        added: null,
        removed: null,
        binary: false,
      });
    }

    for (const u of status.unstaged) {
      const arrowIdx = u.path.indexOf(" → ");
      const origPath = arrowIdx !== -1 ? u.path.slice(0, arrowIdx) : null;
      const targetPath = arrowIdx !== -1 ? u.path.slice(arrowIdx + 3) : u.path;
      const existing = entryMap.get(targetPath);
      if (existing) {
        existing.unstaged = true;
      } else {
        entryMap.set(targetPath, {
          path: targetPath,
          origPath,
          status: u.code === "A" ? "added" : u.code === "D" ? "deleted" : u.code === "R" || origPath ? "renamed" : "modified",
          staged: false,
          unstaged: true,
          added: null,
          removed: null,
          binary: false,
        });
      }
    }

    for (const conf of status.conflicted) {
      const existing = entryMap.get(conf);
      if (existing) {
        existing.status = "conflicted";
      } else {
        entryMap.set(conf, {
          path: conf,
          origPath: null,
          status: "conflicted",
          staged: false,
          unstaged: true,
          added: null,
          removed: null,
          binary: false,
        });
      }
    }

    for (const untracked of status.untracked) {
      entryMap.set(untracked, {
        path: untracked,
        origPath: null,
        status: "untracked",
        staged: false,
        unstaged: true,
        added: null,
        removed: null,
        binary: false,
      });
    }

    return {
      isRepo: true,
      branch: status.branch,
      detached: status.detached,
      head,
      upstream: status.upstream,
      ahead: status.ahead,
      behind: status.behind,
      midMerge: repoState.midMerge,
      midRebase: repoState.midRebase,
      entries: Array.from(entryMap.values()),
      countsOmitted: true,
    };
  }

  // Under 500 files: compute numstat for unstaged, staged, and untracked
  const [unstagedNumstatRes, stagedNumstatRes, untrackedMap] = await Promise.all([
    runGit(projectPath, ["diff", "--numstat", "-z"]),
    runGit(projectPath, ["diff", "--cached", "--numstat", "-z"]),
    getUntrackedNumstat(projectPath, status.untracked),
  ]);

  const unstagedNumstat = parseNumstatZ(unstagedNumstatRes.output);
  const stagedNumstat = parseNumstatZ(stagedNumstatRes.output);

  const entryMap = new Map<string, ChangeEntryDTO>();

  // Helper to resolve parsed numstat by path or rename
  function getNumstat(map: Map<string, NumstatRecord>, path: string, origPath: string | null): NumstatRecord | undefined {
    return map.get(path) ?? (origPath ? map.get(origPath) : undefined);
  }

  for (const s of status.staged) {
    const arrowIdx = s.path.indexOf(" → ");
    const origPath = arrowIdx !== -1 ? s.path.slice(0, arrowIdx) : null;
    const targetPath = arrowIdx !== -1 ? s.path.slice(arrowIdx + 3) : s.path;
    const stat = getNumstat(stagedNumstat, targetPath, origPath);
    const isBinary = stat?.binary ?? false;

    entryMap.set(targetPath, {
      path: targetPath,
      origPath,
      status: s.code === "A" ? "added" : s.code === "D" ? "deleted" : s.code === "R" || origPath ? "renamed" : "modified",
      staged: true,
      unstaged: false,
      added: isBinary ? null : (stat?.added ?? 0),
      removed: isBinary ? null : (stat?.removed ?? 0),
      binary: isBinary,
    });
  }

  for (const u of status.unstaged) {
    const arrowIdx = u.path.indexOf(" → ");
    const origPath = arrowIdx !== -1 ? u.path.slice(0, arrowIdx) : null;
    const targetPath = arrowIdx !== -1 ? u.path.slice(arrowIdx + 3) : u.path;
    const stat = getNumstat(unstagedNumstat, targetPath, origPath);
    const isBinary = stat?.binary ?? false;

    const existing = entryMap.get(targetPath);
    if (existing) {
      existing.unstaged = true;
      if (isBinary || existing.binary) {
        existing.binary = true;
        existing.added = null;
        existing.removed = null;
      } else {
        existing.added = (existing.added ?? 0) + (stat?.added ?? 0);
        existing.removed = (existing.removed ?? 0) + (stat?.removed ?? 0);
      }
    } else {
      entryMap.set(targetPath, {
        path: targetPath,
        origPath,
        status: u.code === "A" ? "added" : u.code === "D" ? "deleted" : u.code === "R" || origPath ? "renamed" : "modified",
        staged: false,
        unstaged: true,
        added: isBinary ? null : (stat?.added ?? 0),
        removed: isBinary ? null : (stat?.removed ?? 0),
        binary: isBinary,
      });
    }
  }

  for (const conf of status.conflicted) {
    const existing = entryMap.get(conf);
    if (existing) {
      existing.status = "conflicted";
    } else {
      entryMap.set(conf, {
        path: conf,
        origPath: null,
        status: "conflicted",
        staged: false,
        unstaged: true,
        added: 0,
        removed: 0,
        binary: false,
      });
    }
  }

  for (const untracked of status.untracked) {
    const stat = untrackedMap.get(untracked);
    const isBinary = stat?.binary ?? false;
    entryMap.set(untracked, {
      path: untracked,
      origPath: null,
      status: "untracked",
      staged: false,
      unstaged: true,
      added: isBinary ? null : (stat?.added ?? null),
      removed: isBinary ? null : (stat?.removed ?? null),
      binary: isBinary,
    });
  }

  return {
    isRepo: true,
    branch: status.branch,
    detached: status.detached,
    head,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    midMerge: repoState.midMerge,
    midRebase: repoState.midRebase,
    entries: Array.from(entryMap.values()),
    countsOmitted: false,
  };
}

function stripDiffPreamble(diff: string): string {
  const hunkIdx = diff.indexOf("@@");
  if (hunkIdx === -1) return diff;
  return diff.slice(hunkIdx);
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function readDiff(
  projectPath: string,
  relPath: string,
  staged: boolean,
): Promise<ChangeDiffDTO> {
  const absPath = resolveInProject(projectPath, relPath);

  // Fast check: if file exists on disk and first 8KB has NUL, it's binary
  if (existsSync(absPath)) {
    try {
      const buf = readFileSync(absPath);
      if (isBinaryBuffer(buf)) {
        return { path: relPath, diff: "", binary: true, truncated: false };
      }
    } catch {
      // best-effort
    }
  }

  const status = await getStatus(projectPath);
  const isUntracked = status.untracked.includes(relPath);

  let res;
  if (isUntracked) {
    res = await runGit(projectPath, ["diff", "--no-index", "--", "/dev/null", relPath]);
    if (res.exitCode !== 0 && res.exitCode !== 1) {
      throw new Error(`git diff --no-index failed: ${res.output}`);
    }
  } else if (staged) {
    res = await runGit(projectPath, ["diff", "--cached", "--", relPath]);
  } else {
    res = await runGit(projectPath, ["diff", "--", relPath]);
  }

  if (res.output.includes("Binary files") && res.output.includes("differ")) {
    return { path: relPath, diff: "", binary: true, truncated: false };
  }

  const stripped = stripDiffPreamble(res.output);
  const { content, truncated } = headTailTruncate(stripped, 400_000);

  return {
    path: relPath,
    diff: content,
    binary: false,
    truncated,
  };
}
