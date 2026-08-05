import type { CreateProjectInput, ProjectDTO } from "@rama/protocol";
import { db } from "./index";
import { newId } from "./ids";

interface ProjectRow {
  id: string;
  name: string;
  path: string;
  repo_url: string | null;
  default_branch: string | null;
  created_at: number;
}

function toDTO(row: ProjectRow): ProjectDTO {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    repoUrl: row.repo_url,
    defaultBranch: row.default_branch,
    createdAt: row.created_at,
  };
}

export function listProjects(): ProjectDTO[] {
  const rows = db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY created_at ASC").all();
  return rows.map(toDTO);
}

export function getProject(id: string): ProjectDTO | null {
  const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id = ?").get(id);
  return row ? toDTO(row) : null;
}

export function createProject(input: CreateProjectInput): ProjectDTO {
  const id = newId();
  const createdAt = Date.now();
  db.query(
    "INSERT INTO projects (id, name, path, repo_url, default_branch, settings_json, created_at) VALUES (?, ?, ?, NULL, NULL, '{}', ?)",
  ).run(id, input.name, input.path, createdAt);
  return { id, name: input.name, path: input.path, repoUrl: null, defaultBranch: null, createdAt };
}
