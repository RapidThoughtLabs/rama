import type { MessageDTO, MessageRole } from "@rama/protocol";
import { db } from "./index";
import { newId } from "./ids";

interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  role: MessageRole;
  content: string | null;
  thinking: string | null;
  created_at: number;
}

function toDTO(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    thinking: row.thinking,
    createdAt: row.created_at,
  };
}

export function listMessages(chatId: string): MessageDTO[] {
  const rows = db
    .query<
      MessageRow,
      [string]
    >("SELECT id, chat_id, seq, role, content, thinking, created_at FROM messages WHERE chat_id = ? ORDER BY seq ASC")
    .all(chatId);
  return rows.map(toDTO);
}

export function appendMessage(
  chatId: string,
  input: { role: MessageRole; content: string | null; thinking?: string | null },
): MessageDTO {
  const id = newId();
  const now = Date.now();
  const nextSeqRow = db
    .query<{ seq: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?")
    .get(chatId);
  const seq = nextSeqRow?.seq ?? 1;

  db.query(
    `INSERT INTO messages (id, chat_id, seq, role, content, thinking, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
  ).run(id, chatId, seq, input.role, input.content, input.thinking ?? null, now);

  return { id, chatId, seq, role: input.role, content: input.content, thinking: input.thinking ?? null, createdAt: now };
}

// Finalizes an assistant row created empty at run start (before any tool calls, which need
// its id as their message_id FK) once the run has fully streamed, errored, or been interrupted.
// `reasoningSignature` (docs/LOOP_MENDING_PLAN.md D6/MD4) — Anthropic's opaque thinking-block
// signature — has no dedicated column; it rides the existing, otherwise-unused `meta_json`
// rather than adding a migration for one nullable string.
export function finalizeMessage(
  id: string,
  content: string | null,
  thinking?: string | null,
  reasoningSignature?: string,
): void {
  if (reasoningSignature) {
    db.query("UPDATE messages SET content = ?, thinking = ?, meta_json = ? WHERE id = ?").run(
      content,
      thinking ?? null,
      JSON.stringify({ reasoningSignature }),
      id,
    );
  } else if (thinking !== undefined) {
    db.query("UPDATE messages SET content = ?, thinking = ? WHERE id = ?").run(content, thinking, id);
  } else {
    db.query("UPDATE messages SET content = ? WHERE id = ?").run(content, id);
  }
}

// The read half of the meta_json signature round-trip above — used only by
// agent/run/transcript.ts's buildTranscriptFromDb when rebuilding a historical assistant entry
// that has thinking text, so it isn't spent on the common (non-reasoning) case.
export function getMessageReasoningSignature(id: string): string | undefined {
  const row = db.query<{ meta_json: string }, [string]>("SELECT meta_json FROM messages WHERE id = ?").get(id);
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.meta_json) as { reasoningSignature?: unknown };
    return typeof parsed.reasoningSignature === "string" ? parsed.reasoningSignature : undefined;
  } catch {
    return undefined;
  }
}

interface ProjectMessageRow {
  id: string;
  chat_id: string;
  seq: number;
  role: MessageRole;
  content: string | null;
}

export interface ProjectMessage {
  id: string;
  chatId: string;
  seq: number;
  role: MessageRole;
  content: string | null;
}

// docs/PROMPT_STACK_PLAN.md §7.2, Phase PS7 — the curator's other evidence read path: user turns
// across a project, ordered so a collector can look at each one's immediate predecessor to tell
// "opening ask" from "reply to what the agent just did" without a second query per row.
export function listMessagesForProject(projectId: string, limit = 4000): ProjectMessage[] {
  const rows = db
    .query<
      ProjectMessageRow,
      [string, number]
    >(`SELECT m.id, m.chat_id, m.seq, m.role, m.content
       FROM messages m JOIN chats c ON c.id = m.chat_id
       WHERE c.project_id = ?
       ORDER BY m.chat_id ASC, m.seq ASC LIMIT ?`,
    )
    .all(projectId, limit);
  return rows.map((row) => ({ id: row.id, chatId: row.chat_id, seq: row.seq, role: row.role, content: row.content }));
}
