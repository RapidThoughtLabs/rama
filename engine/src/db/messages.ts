import type { ChatBlock, MessageDTO, MessageRole } from "@rama/protocol";
import { deleteAttachmentsForMessage, listAttachmentsByMessage, toAttachmentDTO, unlinkAttachments } from "./attachments";
import { db } from "./index";
import { newId } from "./ids";

interface MessageRow {
  id: string;
  chat_id: string;
  seq: number;
  role: MessageRole;
  content: string | null;
  thinking: string | null;
  meta_json: string;
  created_at: number;
}

function toDTO(row: MessageRow): MessageDTO {
  let blocks: ChatBlock[] | undefined;
  let producedBy: { providerId?: string; model?: string } = {};
  if (row.meta_json) {
    try {
      const meta = JSON.parse(row.meta_json) as { blocks?: ChatBlock[]; providerId?: unknown; model?: unknown };
      if (Array.isArray(meta.blocks) && meta.blocks.length > 0) {
        blocks = meta.blocks;
      }
      if (typeof meta.providerId === "string" && typeof meta.model === "string") {
        producedBy = { providerId: meta.providerId, model: meta.model };
      }
    } catch {
      // ignore
    }
  }

  // Fallback if no blocks persisted: synthesize from thinking and content
  if (!blocks && (row.content || row.thinking)) {
    blocks = [];
    if (row.thinking) {
      blocks.push({ kind: "thinking", text: row.thinking });
    }
    if (row.content) {
      blocks.push({ kind: "text", text: row.content });
    }
  }

  return {
    id: row.id,
    chatId: row.chat_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    thinking: row.thinking,
    blocks,
    createdAt: row.created_at,
    ...producedBy,
  };
}

export function listMessages(chatId: string): MessageDTO[] {
  const rows = db
    .query<
      MessageRow,
      [string]
    >("SELECT id, chat_id, seq, role, content, thinking, meta_json, created_at FROM messages WHERE chat_id = ? ORDER BY seq ASC")
    .all(chatId);
  // HD7 — a user turn's files, from message_attachments.
  const attachments = listAttachmentsByMessage(chatId);
  return rows.map((row) => {
    const dto = toDTO(row);
    const files = attachments.get(row.id);
    return files ? { ...dto, attachments: files.map(toAttachmentDTO) } : dto;
  });
}

// `producedBy` (HOME_REDESIGN_PLAN.md HD6) records which model wrote an assistant row, for Home's
// turn byline. It rides meta_json like `blocks`, and finalizeMessage's merge keeps it.
export function appendMessage(
  chatId: string,
  input: { role: MessageRole; content: string | null; thinking?: string | null; producedBy?: { providerId: string; model: string } },
): MessageDTO {
  const id = newId();
  const now = Date.now();
  const nextSeqRow = db
    .query<{ seq: number }, [string]>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM messages WHERE chat_id = ?")
    .get(chatId);
  const seq = nextSeqRow?.seq ?? 1;

  db.query(
    `INSERT INTO messages (id, chat_id, seq, role, content, thinking, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, chatId, seq, input.role, input.content, input.thinking ?? null, input.producedBy ? JSON.stringify(input.producedBy) : "{}", now);

  return { id, chatId, seq, role: input.role, content: input.content, thinking: input.thinking ?? null, createdAt: now, ...input.producedBy };
}

// HOME_REDESIGN_PLAN.md HD6 — Home's "Try again": drops a user message and everything after it (the
// assistant rows, their tool calls and artifacts, and any later turns), returning that message's
// text so the caller can run it again as a fresh turn. `userTurn` is the message's 0-based position
// among the chat's user messages; omitted, it's the last one. Null when there's no such message.
// HD7 — the retried message's attachments are unlinked rather than deleted (`attachmentIds`, to go
// on the re-run); later turns' attachment rows go, and `removedPaths` are their files.
const rewindTx = db.transaction((chatId: string, fromSeq: number, keepFrom: string) => {
  const ids = db
    .query<{ id: string }, [string, number]>("SELECT id FROM messages WHERE chat_id = ? AND seq >= ?")
    .all(chatId, fromSeq)
    .map((r) => r.id);
  const attachmentIds = unlinkAttachments(keepFrom);
  const removedPaths: string[] = [];
  for (const id of ids) {
    removedPaths.push(...deleteAttachmentsForMessage(id));
    db.query("DELETE FROM artifacts WHERE message_id = ?").run(id);
    db.query("DELETE FROM artifacts WHERE tool_call_id IN (SELECT id FROM tool_calls WHERE message_id = ?)").run(id);
    db.query("DELETE FROM tool_calls WHERE message_id = ?").run(id);
  }
  // A compaction whose boundary falls inside the dropped turn summarized rows that no longer exist.
  db.query("DELETE FROM compactions WHERE chat_id = ? AND boundary_seq >= ?").run(chatId, fromSeq);
  db.query("DELETE FROM messages WHERE chat_id = ? AND seq >= ?").run(chatId, fromSeq);
  return { attachmentIds, removedPaths };
});

export interface Rewound {
  text: string;
  attachmentIds: string[];
  removedPaths: string[];
}

export function rewindToUserTurn(chatId: string, userTurn?: number): Rewound | null {
  const users = db
    .query<{ id: string; seq: number; content: string | null }, [string]>("SELECT id, seq, content FROM messages WHERE chat_id = ? AND role = 'user' ORDER BY seq ASC")
    .all(chatId);
  const target = userTurn === undefined ? users[users.length - 1] : users[userTurn];
  if (!target) return null;
  // A turn may be files alone, with no text.
  const hasFiles = db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM message_attachments WHERE message_id = ?").get(target.id)!.n > 0;
  if (!target.content && !hasFiles) return null;
  const { attachmentIds, removedPaths } = rewindTx(chatId, target.seq, target.id);
  return { text: target.content ?? "", attachmentIds, removedPaths };
}

// Finalizes an assistant row created empty at run start (before any tool calls, which need
// its id as their message_id FK) once the run has fully streamed, errored, or been interrupted.
// `reasoningSignature` (docs/LOOP_MENDING_PLAN.md D6/MD4) and `blocks` (docs/CHAT_VIEW_PLAN.md CV6)
// ride `meta_json`, merging with existing content rather than overwriting.
export function finalizeMessage(
  id: string,
  content: string | null,
  thinking?: string | null,
  reasoningSignature?: string,
  blocks?: ChatBlock[],
): void {
  const existingRow = db.query<{ meta_json: string }, [string]>("SELECT meta_json FROM messages WHERE id = ?").get(id);
  let meta: Record<string, unknown> = {};
  if (existingRow?.meta_json) {
    try {
      meta = JSON.parse(existingRow.meta_json);
    } catch {
      meta = {};
    }
  }

  if (reasoningSignature !== undefined) {
    meta.reasoningSignature = reasoningSignature;
  }
  if (blocks !== undefined) {
    meta.blocks = blocks;
  }

  const metaJson = JSON.stringify(meta);
  if (thinking !== undefined) {
    db.query("UPDATE messages SET content = ?, thinking = ?, meta_json = ? WHERE id = ?").run(
      content,
      thinking,
      metaJson,
      id,
    );
  } else {
    db.query("UPDATE messages SET content = ?, meta_json = ? WHERE id = ?").run(content, metaJson, id);
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
