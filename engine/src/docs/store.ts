import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RAMA_HOME } from "../db/index";

// Per-project docs live outside the project's own git repo entirely — under the same app-data
// home as ~/.rama/blobs — rather than inside the project tree. That makes "gitignored" trivially
// true (they're never in the repo) and avoids writing dotfiles/.gitignore entries into a user's
// project without asking.
const DOCS_ROOT = join(RAMA_HOME, "projects");

function docsDir(projectId: string): string {
  return join(DOCS_ROOT, projectId, "docs");
}

function safeName(name: string): string {
  const base = name.trim().replace(/[/\\]/g, "");
  if (!base || base === "." || base === "..") throw new Error("invalid doc name");
  return base.endsWith(".md") ? base : `${base}.md`;
}

export interface DocSummary {
  name: string;
  subtitle: string;
  updatedAt: number;
}

export function listDocs(projectId: string): DocSummary[] {
  const dir = docsDir(projectId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((file) => {
      const path = join(dir, file);
      const content = readFileSync(path, "utf8");
      const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
      return { name: file, subtitle: firstLine.replace(/^#+\s*/, "").slice(0, 120), updatedAt: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function readDoc(projectId: string, name: string): string | null {
  const path = join(docsDir(projectId), safeName(name));
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

export function writeDoc(projectId: string, name: string, content: string): void {
  const dir = docsDir(projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, safeName(name)), content);
}

export function deleteDoc(projectId: string, name: string): boolean {
  const path = join(docsDir(projectId), safeName(name));
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
