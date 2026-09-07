import { runWithTimeout } from "./procRun";

// Shared across glob/tree/read's nearest-match: directories that are never useful to a coding
// agent and are excluded even when a project has no .gitignore of its own (e.g. a fresh repo
// with node_modules already installed but not yet committed).
export const EXCLUDE_DIRS = new Set([".git", "node_modules", "dist", "build", "target", ".next", ".turbo"]);

// git ls-files already respects .gitignore and is fast even on large repos, so it's the primary
// candidate source; a project with no .git falls back to a plain filesystem walk.
export async function listProjectFiles(projectAbsPath: string): Promise<string[]> {
  const { output, exitCode } = await runWithTimeout(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectAbsPath, timeoutMs: 5_000 },
  );
  if (exitCode === 0) return output.split("\n").filter(Boolean);

  const candidates: string[] = [];
  for await (const rel of new Bun.Glob("**/*").scan({ cwd: projectAbsPath, onlyFiles: true, dot: false })) {
    if (rel.split("/").some((seg) => EXCLUDE_DIRS.has(seg))) continue;
    candidates.push(rel);
  }
  return candidates;
}

// Directories git considers ignored, collapsed form (each entry ends in "/" per --directory).
// Empty set (rather than throwing) when the project isn't a git repo — callers fall back to
// EXCLUDE_DIRS alone in that case.
export async function listIgnoredDirs(projectAbsPath: string): Promise<Set<string>> {
  const { output, exitCode } = await runWithTimeout(
    ["git", "ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    { cwd: projectAbsPath, timeoutMs: 5_000 },
  );
  if (exitCode !== 0) return new Set();
  return new Set(output.split("\n").filter(Boolean).map((p) => p.replace(/\/$/, "")));
}
