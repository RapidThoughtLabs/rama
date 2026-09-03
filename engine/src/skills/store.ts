import { db } from "../db/index";
import { newId } from "../db/ids";
import type { SkillRow } from "./types";

export function listInstalledSkills(): SkillRow[] {
  return db.query<SkillRow, []>("SELECT * FROM skills ORDER BY installed_at DESC").all();
}

export function getInstalledSkill(name: string): SkillRow | null {
  return db.query<SkillRow, [string]>("SELECT * FROM skills WHERE name = ?").get(name);
}

export function insertSkill(input: { name: string; source: string; path: string; description: string | null }): SkillRow {
  const id = newId();
  const installedAt = Date.now();
  db.query(
    "INSERT INTO skills (id, name, source, path, description, installed_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, input.name, input.source, input.path, input.description, installedAt);
  return { id, name: input.name, source: input.source, path: input.path, description: input.description, installed_at: installedAt };
}

export function deleteSkill(name: string): boolean {
  const result = db.query("DELETE FROM skills WHERE name = ?").run(name);
  return result.changes > 0;
}
