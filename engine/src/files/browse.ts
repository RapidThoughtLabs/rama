import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import type { FileContentDTO, FileEntryDTO } from "@rama/protocol";
import { resolveInProject } from "../tools/paths";
import { EXCLUDE_DIRS, listIgnoredDirs, listProjectFiles } from "../tools/projectFiles";

// docs/WORKSPACE_PANES_PLAN.md §6.5 — Files browse & read API (Phase W5).

const MAX_CONTENT_BYTES = 2 * 1024 * 1024; // 2MB cap
const SNIFF_BYTES = 8192; // 8KB binary sniff
const MAX_LISTING_ENTRIES = 1000;

// Memoize listIgnoredDirs per project for 30 seconds
const ignoredDirsCache = new Map<string, { expiresAt: number; set: Set<string> }>();

export function clearIgnoredDirsCache(): void {
  ignoredDirsCache.clear();
}

async function getCachedIgnoredDirs(projectAbsPath: string): Promise<Set<string>> {
  const now = Date.now();
  const cached = ignoredDirsCache.get(projectAbsPath);
  if (cached && cached.expiresAt > now) {
    return cached.set;
  }
  const set = await listIgnoredDirs(projectAbsPath);
  ignoredDirsCache.set(projectAbsPath, { expiresAt: now + 30_000, set });
  return set;
}

export async function listDirectory(
  projectPath: string,
  relPath = "",
): Promise<{ entries: FileEntryDTO[] }> {
  const absDir = resolveInProject(projectPath, relPath);
  const ignoredDirs = await getCachedIgnoredDirs(projectPath);

  const rawEntries = readdirSync(absDir, { withFileTypes: true });
  const entries: FileEntryDTO[] = [];

  const slice = rawEntries.slice(0, MAX_LISTING_ENTRIES);

  for (const d of slice) {
    const name = d.name;
    const entryRelPath = relPath ? `${relPath}/${name}` : name;
    let kind: FileEntryDTO["kind"] = "file";

    if (d.isSymbolicLink()) {
      kind = "symlink";
    } else if (d.isDirectory()) {
      kind = "dir";
    }

    let size: number | null = null;
    if (kind !== "dir") {
      try {
        const absEntry = resolveInProject(projectPath, entryRelPath);
        size = statSync(absEntry).size;
      } catch {
        // best-effort
      }
    }

    const isIgnored =
      EXCLUDE_DIRS.has(name) ||
      ignoredDirs.has(entryRelPath) ||
      Array.from(ignoredDirs).some((ig) => entryRelPath === ig || entryRelPath.startsWith(`${ig}/`));

    entries.push({
      name,
      path: entryRelPath,
      kind,
      size,
      ignored: isIgnored,
    });
  }

  // Sort: directories first, then files; both alphabetical
  entries.sort((a, b) => {
    if (a.kind === "dir" && b.kind !== "dir") return -1;
    if (a.kind !== "dir" && b.kind === "dir") return 1;
    return a.name.localeCompare(b.name);
  });

  return { entries };
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/^(\.\/)+/, "").replace(/^\/+/, "");
}

// A file reference surfaced in the UI (a tool call's raw `path` input, or a path-shaped span in
// chat prose) is frequently not the exact project-root-relative path our own file tools store —
// a bare filename, a "./"-prefixed shorthand, or a path relative to whatever directory the model
// had in mind when it wrote it. Resolve it the same way read.ts's tool-call "did you mean"
// (suggestNearestPaths) does, but silently when there's exactly one unambiguous match — this is a
// click-to-open UX, not an error message, so guessing wrong (multiple/no matches) must still fall
// through to the caller's existing not-found handling rather than silently opening the wrong file.
async function resolveRelPath(projectPath: string, relPath: string): Promise<string> {
  const cleaned = normalizeRelPath(relPath);
  if (existsSync(resolveInProject(projectPath, cleaned))) return cleaned;

  const files = await listProjectFiles(projectPath);
  const suffixMatches = files.filter((f) => f === cleaned || f.endsWith(`/${cleaned}`));
  if (suffixMatches.length === 1) return suffixMatches[0]!;

  const base = cleaned.split("/").pop();
  if (base) {
    const baseMatches = files.filter((f) => f.split("/").pop() === base);
    if (baseMatches.length === 1) return baseMatches[0]!;
  }

  return cleaned;
}

function isBinaryBuffer(buf: Buffer): boolean {
  const checkLen = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

export async function readFileContent(
  projectPath: string,
  rawRelPath: string,
): Promise<FileContentDTO> {
  const relPath = await resolveRelPath(projectPath, rawRelPath);
  const absPath = resolveInProject(projectPath, relPath);

  // Symlink check: verify symlink target stays inside project
  const lstat = lstatSync(absPath);
  if (lstat.isSymbolicLink()) {
    const real = realpathSync(absPath);
    const relToRoot = relative(projectPath, real);
    if (relToRoot === ".." || relToRoot.startsWith(`..${"/"}`) || isAbsolute(relToRoot)) {
      throw new Error(`symlink target "${relPath}" escapes the project directory`);
    }
  }

  const stat = statSync(absPath);
  const size = stat.size;

  // Sniff first 8KB for binary NUL byte
  const fd = readFileSync(absPath);
  if (isBinaryBuffer(fd)) {
    return {
      path: relPath,
      content: "",
      size,
      lines: 0,
      binary: true,
      truncated: false,
    };
  }

  // Cap at 2MB
  if (size > MAX_CONTENT_BYTES) {
    const truncatedBuf = fd.subarray(0, MAX_CONTENT_BYTES);
    const content = truncatedBuf.toString("utf8");
    const lines = content.split("\n").length;
    return {
      path: relPath,
      content,
      size,
      lines,
      binary: false,
      truncated: true,
    };
  }

  const content = fd.toString("utf8");
  const lines = content.split("\n").length;

  return {
    path: relPath,
    content,
    size,
    lines,
    binary: false,
    truncated: false,
  };
}
