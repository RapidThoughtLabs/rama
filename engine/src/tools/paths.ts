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
