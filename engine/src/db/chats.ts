import type { BackendConfig, ChatDTO, ChatMode, CreateChatInput, ThemeIdDTO, UpdateChatInput } from "@rama/protocol";
import { DEFAULT_MODEL, DEFAULT_PROVIDER_ID } from "../agent/config";
import { db } from "./index";
import { newId } from "./ids";

const OWN_LOOP_BACKEND: BackendConfig = { kind: "own-loop" };

// Every chat pre-Phase-8 was inserted with a literal '{}' — parse that (and anything else
// unparseable) as own-loop so existing chats keep behaving exactly as they do today.
function parseBackend(json: string): BackendConfig {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && "kind" in parsed ? (parsed as BackendConfig) : OWN_LOOP_BACKEND;
  } catch {
    return OWN_LOOP_BACKEND;
  }
}

interface ChatRow {
  id: string;
  project_id: string;
  title: string;
  backend_json: string;
  provider_id: string;
  model: string | null;
  mode: ChatMode;
  theme_id: ThemeIdDTO;
  status: string;
  cost_usd: number;
  context_used: number;
  context_max: number;
  created_at: number;
  updated_at: number;
}

function toDTO(row: ChatRow): ChatDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    backend: parseBackend(row.backend_json),
    providerId: row.provider_id,
    model: row.model,
    mode: row.mode,
    themeId: row.theme_id,
    status: row.status,
    costUsd: row.cost_usd,
    contextUsed: row.context_used,
    contextMax: row.context_max,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CHAT_COLUMNS = "id, project_id, title, backend_json, provider_id, model, mode, theme_id, status, cost_usd, context_used, context_max, created_at, updated_at";

export function listAllChats(): ChatDTO[] {
  const rows = db.query<ChatRow, []>(`SELECT ${CHAT_COLUMNS} FROM chats ORDER BY updated_at DESC`).all();
  return rows.map(toDTO);
}

export function listChatsByProject(projectId: string): ChatDTO[] {
  const rows = db
    .query<ChatRow, [string]>(`SELECT ${CHAT_COLUMNS} FROM chats WHERE project_id = ? ORDER BY updated_at DESC`)
    .all(projectId);
  return rows.map(toDTO);
}

export function getChat(id: string): ChatDTO | null {
  const row = db.query<ChatRow, [string]>(`SELECT ${CHAT_COLUMNS} FROM chats WHERE id = ?`).get(id);
  return row ? toDTO(row) : null;
}

export function createChat(projectId: string, input: CreateChatInput): ChatDTO {
  const id = newId();
  const now = Date.now();
  const title = input.title ?? "new chat";
  const backendJson = JSON.stringify(input.backend ?? OWN_LOOP_BACKEND);
  const providerId = input.providerId ?? DEFAULT_PROVIDER_ID;
  const mode = input.mode ?? "agent";
  const themeId = input.themeId ?? "kanagawa";

  db.query(
    // `wallpaper` isn't in this insert (engine/src/db/schema.ts marks the column dead —
    // SETTINGS_PLAN.md Phase S0: the wallpaper is theme-authored data now, not per-chat state).
    // It keeps its NOT NULL DEFAULT, so the row still inserts fine without it named here.
    `INSERT INTO chats (id, project_id, title, backend_json, provider_id, model, mode, theme_id, status, cost_usd, context_used, context_max, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, 200000, ?, ?)`,
  ).run(id, projectId, title, backendJson, providerId, input.model ?? DEFAULT_MODEL, mode, themeId, now, now);

  return getChat(id)!;
}

const PATCHABLE_COLUMNS: Record<keyof UpdateChatInput, string> = {
  title: "title",
  backend: "backend_json",
  providerId: "provider_id",
  model: "model",
  mode: "mode",
  themeId: "theme_id",
  status: "status",
};

export function updateChat(id: string, patch: UpdateChatInput): ChatDTO | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(patch) as (keyof UpdateChatInput)[]) {
    const column = PATCHABLE_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(key === "backend" ? JSON.stringify(patch[key]) : patch[key]);
  }

  if (sets.length === 0) return getChat(id);

  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  db.query(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...(values as []));
  return getChat(id);
}

// messages/tool_calls/artifacts reference chats(id) with no ON DELETE CASCADE (schema.ts), and
// `PRAGMA foreign_keys = ON` (db/index.ts) means dropping the chat row first would just throw —
// so the dependents are deleted explicitly, in one transaction so a failure partway through
// can't leave the chat orphaned from its own history.
const deleteChatTx = db.transaction((id: string) => {
  db.query("DELETE FROM artifacts WHERE chat_id = ?").run(id);
  db.query("DELETE FROM tool_calls WHERE chat_id = ?").run(id);
  db.query("DELETE FROM messages WHERE chat_id = ?").run(id);
  db.query("DELETE FROM chats WHERE id = ?").run(id);
});

export function deleteChat(id: string): boolean {
  if (!getChat(id)) return false;
  deleteChatTx(id);
  return true;
}

// Internal — usage/cost are engine-computed, not user-editable input, so this stays
// separate from updateChat/PATCHABLE_COLUMNS (which back the public PATCH /chats/:id route).
export function recordUsage(id: string, usage: { contextUsed: number; costUsd: number }): ChatDTO | null {
  db.query("UPDATE chats SET context_used = ?, cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?").run(
    usage.contextUsed,
    usage.costUsd,
    Date.now(),
    id,
  );
  return getChat(id);
}
