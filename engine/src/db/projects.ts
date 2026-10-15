import type {
  CreateProjectInput,
  PermissionSettings,
  PermissionTool,
  ProjectDTO,
  ProjectPermissionPatch,
  UpdateProjectInput,
} from "@rama/protocol";
import { db } from "./index";
import { newId } from "./ids";
import { listChatsByProject } from "./chats";
import { deleteProposalsForProject } from "./curationProposals";

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

// System projects (HOME_REDESIGN_PLAN.md Decision D3 — the hidden "home" project) are never
// listed; getProject still returns them, since the run loop resolves a Home chat's project by id.
export function listProjects(): ProjectDTO[] {
  const rows = db.query<ProjectRow, []>("SELECT * FROM projects WHERE is_system = 0 ORDER BY created_at ASC").all();
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

const PATCHABLE_COLUMNS: Record<keyof UpdateProjectInput, string> = {
  name: "name",
  defaultBranch: "default_branch",
};

export function updateProject(id: string, patch: UpdateProjectInput): ProjectDTO | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(patch) as (keyof UpdateProjectInput)[]) {
    const column = PATCHABLE_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key]);
  }

  if (sets.length === 0) return getProject(id);

  values.push(id);
  db.query(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...(values as []));
  return getProject(id);
}

// docs/REDESIGN_PLAN.md Phase R2b — reject rather than cascade: chats.project_id has no
// ON DELETE CASCADE (schema.ts), and silently deleting a project's chats/messages/artifacts
// alongside it is a bigger destructive surface than the sidebar's "remove project" action asked
// for. The caller (server.ts) surfaces this as a 409 telling the user to move/delete chats first.
export function deleteProject(id: string): "ok" | "not-found" | "has-chats" | "system" {
  if (!getProject(id)) return "not-found";
  if (isSystemProject(id)) return "system";
  if (listChatsByProject(id).length > 0) return "has-chats";
  deleteProposalsForProject(id);
  db.query("DELETE FROM projects WHERE id = ?").run(id);
  return "ok";
}

export function isSystemProject(id: string): boolean {
  const row = db.query<{ is_system: number }, [string]>("SELECT is_system FROM projects WHERE id = ?").get(id);
  return row?.is_system === 1;
}

interface ProjectSettingsJson {
  permissions?: PermissionSettings;
}

function readSettingsJson(id: string): ProjectSettingsJson | null {
  const row = db.query<{ settings_json: string }, [string]>("SELECT settings_json FROM projects WHERE id = ?").get(id);
  if (!row) return null;
  try {
    return JSON.parse(row.settings_json) as ProjectSettingsJson;
  } catch {
    return {};
  }
}

// docs/REDESIGN_PLAN.md Phase R4 — the Settings modal's per-project permission override, layered
// on top of the global defaults (engine/src/db/settings.ts's "permissions" key) rather than
// replacing them; only the tools a project explicitly overrides appear here.
export function getProjectPermissions(id: string): PermissionSettings | null {
  const settings = readSettingsJson(id);
  return settings === null ? null : (settings.permissions ?? {});
}

export function updateProjectPermissions(id: string, patch: ProjectPermissionPatch): PermissionSettings | null {
  const settings = readSettingsJson(id);
  if (settings === null) return null;
  const merged: PermissionSettings = { ...(settings.permissions ?? {}) };
  for (const [tool, rule] of Object.entries(patch) as [PermissionTool, PermissionSettings[PermissionTool] | null][]) {
    if (rule === null) delete merged[tool];
    else merged[tool] = rule;
  }
  db.query("UPDATE projects SET settings_json = ? WHERE id = ?").run(
    JSON.stringify({ ...settings, permissions: merged }),
    id,
  );
  return merged;
}
