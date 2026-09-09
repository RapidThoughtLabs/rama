// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the curator's second hard rule: "every entry
// carries provenance and a verification hook. An entry naming a script is checked against
// package.json before it is trusted... an entry whose referent is gone is proposed for deletion,
// not silently obeyed." Two uses of the same checks: gate a fresh `## Commands` candidate before
// it is even sent to the phrasing model (verifyCommand), and re-check every bullet already in
// RAMA.md so a script that got deleted after the entry was written surfaces as a removal
// proposal (findStaleEntries) instead of sitting there lying to every future session forever.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getProjectInstructions } from "../instructions";

interface PackageJson {
  scripts?: Record<string, string>;
}

function readPackageScripts(projectPath: string): Record<string, string> | null {
  try {
    const raw = readFileSync(join(projectPath, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as PackageJson;
    return parsed.scripts ?? {};
  } catch {
    return null;
  }
}

const RUN_SCRIPT_RE = /^(?:npm|pnpm|yarn|bun)\s+run\s+([\w:.-]+)/;
// `npm test` / `bun test` / `npm start` are conventional entry points that work with no
// package.json "scripts" entry at all (npm falls back to a default, bun test is a built-in
// runner) — only the explicit `run <script>` form names something that has to actually exist.
export function verifyCommand(command: string, projectPath: string): boolean {
  const match = command.trim().match(RUN_SCRIPT_RE);
  if (!match) return true;
  const scripts = readPackageScripts(projectPath);
  if (!scripts) return false;
  return match[1] in scripts;
}

const PATH_LIKE_RE = /^[\w./-]+\.[a-zA-Z0-9]+$|^[\w-]+\/[\w./-]+$/;

// A backticked token from a RAMA.md bullet is worth checking only if it looks like a real
// project-relative path (has a slash or a file extension) and not a bare word or a full shell
// command (those contain spaces, which this never matches).
function looksLikePath(token: string): boolean {
  return PATH_LIKE_RE.test(token);
}

export interface StaleEntry {
  section: string;
  line: string;
}

// Walks the project's own RAMA.md (not global — package.json/paths are project-relative) looking
// for a backticked `npm run X` whose script is gone, or a backticked path that no longer exists.
// Anything else in a bullet (bare words, prose) is left alone — this is a narrow, literal check,
// not a general link-rot scanner.
export function findStaleEntries(projectPath: string): StaleEntry[] {
  const doc = getProjectInstructions(projectPath);
  if (!doc) return [];

  const scripts = readPackageScripts(projectPath);
  let section = "Notes";
  const stale: StaleEntry[] = [];

  for (const rawLine of doc.content.split("\n")) {
    const headingMatch = rawLine.match(/^##\s+(.+)$/);
    if (headingMatch) {
      section = headingMatch[1].trim();
      continue;
    }
    const bulletMatch = rawLine.match(/^-\s+(.*)$/);
    if (!bulletMatch) continue;
    const line = bulletMatch[1];
    const tokenMatch = line.match(/`([^`]+)`/);
    if (!tokenMatch) continue;
    const token = tokenMatch[1];

    const runMatch = token.match(RUN_SCRIPT_RE);
    if (runMatch) {
      if (!scripts || !(runMatch[1] in scripts)) stale.push({ section, line });
      continue;
    }
    if (looksLikePath(token) && !existsSync(join(projectPath, token))) {
      stale.push({ section, line });
    }
  }
  return stale;
}
