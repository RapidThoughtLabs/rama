import type { ChatDTO, ChatMode, CreateChatInput, ThemeModeDTO, UpdateChatInput } from "@rama/protocol";
import { DEFAULT_MODEL, DEFAULT_PROVIDER_ID } from "../agent/config";
import { db } from "./index";
import { newId } from "./ids";

interface ChatRow {
  id: string;
  project_id: string;
  title: string;
  provider_id: string;
  model: string | null;
  mode: ChatMode;
  wallpaper: string;
  accent: string;
  theme: ThemeModeDTO;
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
    providerId: row.provider_id,
    model: row.model,
    mode: row.mode,
    wallpaper: row.wallpaper,
    accent: row.accent,
    theme: row.theme,
    status: row.status,
    costUsd: row.cost_usd,
    contextUsed: row.context_used,
    contextMax: row.context_max,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CHAT_COLUMNS = "id, project_id, title, provider_id, model, mode, wallpaper, accent, theme, status, cost_usd, context_used, context_max, created_at, updated_at";

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
  const providerId = input.providerId ?? DEFAULT_PROVIDER_ID;
  const mode = input.mode ?? "agent";
  const wallpaper = input.wallpaper ?? "indigo";
  const accent = input.accent ?? "plasma";
  const theme = input.theme ?? "dark";

  db.query(
    `INSERT INTO chats (id, project_id, title, backend_json, provider_id, model, mode, wallpaper, accent, theme, status, cost_usd, context_used, context_max, created_at, updated_at)
     VALUES (?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, 'idle', 0, 0, 200000, ?, ?)`,
  ).run(id, projectId, title, providerId, input.model ?? DEFAULT_MODEL, mode, wallpaper, accent, theme, now, now);

  return getChat(id)!;
}

const PATCHABLE_COLUMNS: Record<keyof UpdateChatInput, string> = {
  title: "title",
  providerId: "provider_id",
  model: "model",
  mode: "mode",
  wallpaper: "wallpaper",
  accent: "accent",
  theme: "theme",
  status: "status",
};

export function updateChat(id: string, patch: UpdateChatInput): ChatDTO | null {
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(patch) as (keyof UpdateChatInput)[]) {
    const column = PATCHABLE_COLUMNS[key];
    if (!column) continue;
    sets.push(`${column} = ?`);
    values.push(patch[key]);
  }

  if (sets.length === 0) return getChat(id);

  sets.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);

  db.query(`UPDATE chats SET ${sets.join(", ")} WHERE id = ?`).run(...(values as []));
  return getChat(id);
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
