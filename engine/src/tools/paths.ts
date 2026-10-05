import { isAbsolute, relative, resolve } from "node:path";

// Every tool operates relative to the project's own directory; nothing a tool touches should
// be able to escape it via `..` segments or an absolute path pointing elsewhere.
export function resolveInProject(projectRoot: string, relPath: string): string {
  const resolved = resolve(projectRoot, relPath || ".");
  const rel = relative(projectRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel)) {
    throw new Error(`path "${relPath}" escapes the project directory`);
  }
  return resolved;
}

function isWithinRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel !== ".." && !rel.startsWith(`..${"/"}`) && !isAbsolute(rel);
}

// docs/COMPOSER_CONTEXT_PLAN.md Phase CC1 — the read-only widening of resolveInProject. A chat's
// `extraRoots` are pointers the agent can navigate into on demand (agent/prompt/project.ts's
// formatProjectKnowledge tells it their absolute paths), never part of the chat's own sandbox —
// so this is only ever wired into read/tree/grep/glob (see those files), never edit/write/
// fileOp/gitWrite/git, which stay on resolveInProject and so can never touch an extra root at all.
export function resolveReadPath(projectRoot: string, extraRoots: string[], relOrAbsPath: string): string {
  try {
    return resolveInProject(projectRoot, relOrAbsPath);
  } catch (err) {
    if (isAbsolute(relOrAbsPath)) {
      const resolved = resolve(relOrAbsPath);
      for (const root of extraRoots) {
        if (isWithinRoot(root, resolved)) return resolved;
      }
    }
    throw err;
  }
}
