import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import { SKILLS_HOME } from "./discover";
import { parseSkillMd } from "./frontmatter";
import { deleteSkill, getInstalledSkill, insertSkill } from "./store";
import type { SkillRow } from "./types";

const GIT_SOURCE_RE = /^(https?:\/\/|git@)/;

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

// Installs a skill from a local directory path or a git URL into ~/.rama/skills/<name>, deriving
// the final directory name from SKILL.md's own frontmatter (not the source path/URL, which may
// not match) — so it stages into a scratch dir first, reads SKILL.md, then moves into place.
export async function installSkill(source: string): Promise<SkillRow> {
  mkdirSync(SKILLS_HOME, { recursive: true });
  const isGit = GIT_SOURCE_RE.test(source) || source.endsWith(".git");
  const stagingDir = join(SKILLS_HOME, `.staging-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  try {
    if (isGit) {
      const proc = Bun.spawn(["git", "clone", "--depth", "1", source, stagingDir], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`git clone failed: ${stderr.trim() || `exit code ${exitCode}`}`);
      }
    } else {
      if (!existsSync(source)) throw new Error(`source path not found: ${source}`);
      await cp(source, stagingDir, { recursive: true });
    }

    const mdPath = join(stagingDir, "SKILL.md");
    if (!existsSync(mdPath)) throw new Error("no SKILL.md found at the root of the source");

    const { name, description } = parseSkillMd(readFileSync(mdPath, "utf8"));
    if (!name) throw new Error("SKILL.md is missing a name in its frontmatter");

    const finalDir = join(SKILLS_HOME, sanitizeName(name));
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
    await cp(stagingDir, finalDir, { recursive: true });

    deleteSkill(name);
    return insertSkill({
      name,
      source: isGit ? `git:${source}` : `local:${source}`,
      path: finalDir,
      description: description ?? null,
    });
  } finally {
    if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
  }
}

// Removes both the DB row and the installed directory on disk — deleting the DB row alone would
// leave the skill fully discoverable/callable via discoverSkills(), which scans the filesystem
// directly and doesn't know about the DB at all.
export function uninstallSkill(name: string): boolean {
  const row = getInstalledSkill(name);
  if (!row) return false;
  if (existsSync(row.path)) rmSync(row.path, { recursive: true, force: true });
  return deleteSkill(name);
}
