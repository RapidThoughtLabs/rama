import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CreateHomeChatInput, HomeChatSummaryDTO } from "@rama/protocol";
import { CHAT_COLUMNS, createChat, readChatSettingsJson, toDTO, writeChatSettingsJson, type ChatRow } from "./chats";
import { RAMA_HOME, db } from "./index";
import { snippetFromText } from "./snippet";

// HOME_REDESIGN_PLAN.md Phase HD3 / Decision D3 — Home chats live under one reserved project row
// rather than a nullable chats.project_id, so the run loop, tools and permissions work unchanged.
// The row is a system project: listProjects() never returns it and deleteProject() refuses it.
// Its path is where Home's tools are sandboxed, and where attachments land (HD7).

export const HOME_PROJECT_ID = "home";
export const HOME_AGENT_ID = "home";
export const HOME_DIR = join(RAMA_HOME, "home");

export function homeAttachmentsDir(chatId: string): string {
  return join(HOME_DIR, "attachments", chatId);
}

// Idempotent, run at every boot. An existing row keeps its created_at; name/path/is_system are
// reasserted in case anything ever drifted.
export function ensureHomeProject(): void {
  mkdirSync(HOME_DIR, { recursive: true });
  db.query(
    `INSERT INTO projects (id, name, path, repo_url, default_branch, settings_json, is_system, created_at)
     VALUES (?, 'Home', ?, NULL, NULL, '{}', 1, ?)
     ON CONFLICT(id) DO UPDATE SET name = 'Home', path = excluded.path, is_system = 1`,
  ).run(HOME_PROJECT_ID, HOME_DIR, Date.now());
}

interface HomeChatRow extends ChatRow {
  last_text: string | null;
  settings_json: string;
}

export function listHomeChats(): HomeChatSummaryDTO[] {
  // The snippet's source is the newest assistant message with any text. One correlated subquery
  // per chat, on idx_messages_chat — if this ever shows up as slow, cache it in a chats.snippet
  // column written at run end instead.
  const rows = db
    .query<HomeChatRow, []>(
      `SELECT ${CHAT_COLUMNS}, settings_json,
         (SELECT m.content FROM messages m
           WHERE m.chat_id = chats.id AND m.role = 'assistant' AND m.content IS NOT NULL AND m.content != ''
           ORDER BY m.seq DESC LIMIT 1) AS last_text
       FROM chats WHERE kind = 'home' ORDER BY updated_at DESC`,
    )
    .all();
  return rows.map((row) => ({
    ...toDTO(row),
    snippet: snippetFromText(row.last_text),
    webSearch: parseWebSearch(row.settings_json),
  }));
}

export function createHomeChat(input: CreateHomeChatInput): HomeChatSummaryDTO {
  const chat = createChat(
    HOME_PROJECT_ID,
    { providerId: input.providerId, model: input.model, mode: "agent", agentId: HOME_AGENT_ID },
    "home",
  );
  if (input.webSearch) {
    writeChatSettingsJson(chat.id, { ...(readChatSettingsJson(chat.id) ?? {}), webSearch: true });
  }
  return { ...chat, snippet: null, webSearch: !!input.webSearch };
}

// Best-effort, after the chat row is gone — a leftover folder must never fail the delete.
export function removeHomeChatFiles(chatId: string): void {
  try {
    rmSync(homeAttachmentsDir(chatId), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function parseWebSearch(json: string): boolean {
  try {
    return JSON.parse(json)?.webSearch === true;
  } catch {
    return false;
  }
}
