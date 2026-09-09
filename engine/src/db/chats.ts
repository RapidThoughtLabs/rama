import type { BackendConfig, ChatDTO, ChatMode, CreateChatInput, ThemeIdDTO, UpdateChatInput } from "@rama/protocol";
import { getChatRoleModel } from "../agent/config";
import { db } from "./index";
import { newId } from "./ids";

const OWN_LOOP_BACKEND: BackendConfig = { kind: "own-loop" };

// docs/PROVIDERS_PLAN.md Phase P2 — every new chat starts with this literal title; runTurn's
// first call stubs it from the user's own message the moment there's something better to show.
export const DEFAULT_TITLE = "new chat";

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

// docs/MISSION_CONTROL_PLAN.md §5.4 — one-time boot fixup for chats created before cli-backed
// chats were deleted. A `{"kind":"cli"}` row already falls back to own-loop at read time
// (parseBackend above), but that fallback is silent; this makes it permanent and keeps the old
// launch command visible in the title instead of it just vanishing. This is a prototype DB — no
// migration framework, just a query run once at every boot (a no-op once no rows match).
export function migrateLegacyCliChats(): void {
  const rows = db
    .query<{ id: string; title: string; backend_json: string }, []>(
      `SELECT id, title, backend_json FROM chats WHERE backend_json LIKE '%"kind":"cli"%'`,
    )
    .all();
  if (rows.length === 0) return;

  const now = Date.now();
  for (const row of rows) {
    let command = "cli";
    try {
      const parsed = JSON.parse(row.backend_json);
      if (parsed && typeof parsed.command === "string") command = parsed.command;
    } catch {
      // fall through with the "cli" placeholder
    }
    const title = row.title === DEFAULT_TITLE ? `[${command}]` : `[${command}] ${row.title}`;
    db.query("UPDATE chats SET backend_json = ?, title = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(OWN_LOOP_BACKEND),
      title,
      now,
      row.id,
    );
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
  agent_id: string;
  theme_id: ThemeIdDTO;
  status: string;
  cost_usd: number;
  utility_cost_usd: number;
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
    agentId: row.agent_id,
    themeId: row.theme_id,
    status: row.status,
    costUsd: row.cost_usd,
    utilityCostUsd: row.utility_cost_usd,
    contextUsed: row.context_used,
    contextMax: row.context_max,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const CHAT_COLUMNS =
  "id, project_id, title, backend_json, provider_id, model, mode, agent_id, theme_id, status, cost_usd, utility_cost_usd, context_used, context_max, created_at, updated_at";

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
  const title = input.title ?? DEFAULT_TITLE;
  const backendJson = JSON.stringify(input.backend ?? OWN_LOOP_BACKEND);
  const chatRole = getChatRoleModel();
  const providerId = input.providerId ?? chatRole.providerId;
  const mode = input.mode ?? "agent";
  const agentId = input.agentId ?? "default";
  const themeId = input.themeId ?? "kanagawa";

  db.query(
    // `wallpaper` isn't in this insert (engine/src/db/schema.ts marks the column dead —
    // SETTINGS_PLAN.md Phase S0: the wallpaper is theme-authored data now, not per-chat state).
    // It keeps its NOT NULL DEFAULT, so the row still inserts fine without it named here.
    `INSERT INTO chats (id, project_id, title, backend_json, provider_id, model, mode, agent_id, theme_id, status, cost_usd, utility_cost_usd, context_used, context_max, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', 0, 0, 0, 200000, ?, ?)`,
  ).run(id, projectId, title, backendJson, providerId, input.model ?? chatRole.model, mode, agentId, themeId, now, now);

  return getChat(id)!;
}

// docs/PROVIDERS_PLAN.md Phase P2, auto-titling stage 1 — fires once, on the first user turn: the
// sidebar is never stuck on the literal "new chat" again even if the utility model call (stage 2)
// never runs or fails. A no-op on every later turn since the title is no longer DEFAULT_TITLE.
export function stubTitleFromFirstMessage(id: string, text: string): ChatDTO | null {
  const chat = getChat(id);
  if (!chat || chat.title !== DEFAULT_TITLE) return null;
  const stub = text.trim().slice(0, 40) || DEFAULT_TITLE;
  return updateChat(id, { title: stub });
}

const PATCHABLE_COLUMNS: Record<keyof UpdateChatInput, string> = {
  title: "title",
  backend: "backend_json",
  providerId: "provider_id",
  model: "model",
  mode: "mode",
  agentId: "agent_id",
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
  db.query("DELETE FROM file_reads WHERE chat_id = ?").run(id);
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

// docs/PROVIDERS_PLAN.md Phase P2 — utility-role spend (auto-titling, etc.) is tracked separately
// from recordUsage's cost_usd/context_used so a background title call can never be folded into,
// or overwrite, the chat's own turn cost/context — that's the "role='utility' tagging" the phase
// calls for, applied at the storage layer since there's no cost-breakdown UI to feed yet.
export function recordUtilityUsage(id: string, costUsd: number): void {
  db.query("UPDATE chats SET utility_cost_usd = utility_cost_usd + ? WHERE id = ?").run(costUsd, id);
}
