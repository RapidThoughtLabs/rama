// docs/PROVIDERS_PLAN.md Phase P2 — a role names *why* a call happens, not a setting like
// "cheap model". 'chat' replaces DEFAULT_PROVIDER_ID/DEFAULT_MODEL (engine/src/agent/config.ts);
// 'utility' backs auto-titling and future background calls; 'summarize' is reserved for
// compaction and has no writer yet.
import { db } from "./index";

export type ModelRole = "chat" | "utility" | "summarize";

export interface ModelRoleRow {
  role: ModelRole;
  provider_id: string;
  model_id: string;
  updated_at: number;
}

export function getModelRole(role: ModelRole): ModelRoleRow | null {
  return db.query<ModelRoleRow, [string]>("SELECT * FROM model_roles WHERE role = ?").get(role);
}

export function listModelRoles(): ModelRoleRow[] {
  return db.query<ModelRoleRow, []>("SELECT * FROM model_roles").all();
}

export function setModelRole(role: ModelRole, providerId: string, modelId: string): ModelRoleRow {
  db.query(
    `INSERT INTO model_roles (role, provider_id, model_id, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(role) DO UPDATE SET provider_id = excluded.provider_id, model_id = excluded.model_id, updated_at = excluded.updated_at`,
  ).run(role, providerId, modelId, Date.now());
  return getModelRole(role)!;
}
