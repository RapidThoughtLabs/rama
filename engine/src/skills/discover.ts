import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RAMA_HOME } from "../db/index";
import type { SearchCtx } from "../search/types";
import { parseSkillMd } from "./frontmatter";
import type { SkillMeta } from "./types";

export const SKILLS_HOME = join(RAMA_HOME, "skills");

function scanSkillsDir(dir: string): SkillMeta[] {
  if (!existsSync(dir)) return [];
  const out: SkillMeta[] = [];
  // docs/PROMPT_STACK_PLAN.md §9.4 PS0 — readdirSync's order is filesystem-dependent, not
  // alphabetical; skill_* tools built from this list render at prefix position 0, so an
  // unsorted scan silently invalidates the entire cache on every reorder.
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = join(dir, entry.name);
    const mdPath = join(skillPath, "SKILL.md");
    if (!existsSync(mdPath)) continue;
    const { name, description } = parseSkillMd(readFileSync(mdPath, "utf8"));
    out.push({ name: name ?? entry.name, description: description ?? "", path: skillPath });
  }
  return out;
}

// Single source of truth for both the tool-builder (skills/tools.ts) and the rama search
// provider — global installs (~/.rama/skills) plus project-local drop-ins that need no install
// step. Deduped by name, project-local wins so a repo can override a globally installed skill.
export function discoverSkills(ctx: SearchCtx): SkillMeta[] {
  const global = scanSkillsDir(SKILLS_HOME);
  const local = ctx.projectPath ? scanSkillsDir(join(ctx.projectPath, ".rama", "skills")) : [];

  const byName = new Map<string, SkillMeta>();
  for (const skill of global) byName.set(skill.name, skill);
  for (const skill of local) byName.set(skill.name, skill);
  return [...byName.values()];
}
