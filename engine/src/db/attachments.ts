import type { AttachmentDTO } from "@rama/protocol";
import { db } from "./index";

// HOME_REDESIGN_PLAN.md Phase HD7 — message_attachments rows. The files themselves are written by
// files/attachments.ts; this is only the bookkeeping. An upload is unlinked (message_id NULL)
// until the turn that carries it is recorded, so a file picked but never sent stays invisible.

interface AttachmentRow {
  id: string;
  chat_id: string;
  message_id: string | null;
  name: string;
  mime: string;
  size: number;
  pages: number | null;
  path: string;
}

/** An attachment as the engine sees it: the DTO plus where it lives under the home project. */
export interface StoredAttachment extends AttachmentDTO {
  messageId: string | null;
  /** Relative to the home project — what the read tool takes. */
  path: string;
}

function toStored(row: AttachmentRow): StoredAttachment {
  return {
    id: row.id,
    name: row.name,
    mime: row.mime,
    size: row.size,
    ...(row.pages != null ? { pages: row.pages } : {}),
    messageId: row.message_id,
    path: row.path,
  };
}

export function toAttachmentDTO(a: StoredAttachment): AttachmentDTO {
  return { id: a.id, name: a.name, mime: a.mime, size: a.size, ...(a.pages != null ? { pages: a.pages } : {}) };
}

const COLUMNS = "id, chat_id, message_id, name, mime, size, pages, path";

export function insertAttachment(input: { id: string; chatId: string; name: string; mime: string; size: number; pages?: number; path: string }): StoredAttachment {
  db.query(
    `INSERT INTO message_attachments (id, chat_id, message_id, name, mime, size, pages, path, created_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.chatId, input.name, input.mime, input.size, input.pages ?? null, input.path, Date.now());
  return { id: input.id, name: input.name, mime: input.mime, size: input.size, ...(input.pages != null ? { pages: input.pages } : {}), messageId: null, path: input.path };
}

/** Links this chat's unlinked uploads among `ids` to a message, in the order given. Ids that
 *  belong to another chat or are already on a message are ignored. */
export function linkAttachments(chatId: string, messageId: string, ids: readonly string[]): StoredAttachment[] {
  const linked: StoredAttachment[] = [];
  for (const id of ids) {
    const row = db
      .query<AttachmentRow, [string, string]>(`SELECT ${COLUMNS} FROM message_attachments WHERE id = ? AND chat_id = ? AND message_id IS NULL`)
      .get(id, chatId);
    if (!row) continue;
    db.query("UPDATE message_attachments SET message_id = ? WHERE id = ?").run(messageId, id);
    linked.push(toStored({ ...row, message_id: messageId }));
  }
  return linked;
}

/** Every linked attachment in a chat, grouped by message, in upload order. */
export function listAttachmentsByMessage(chatId: string): Map<string, StoredAttachment[]> {
  const rows = db
    .query<AttachmentRow, [string]>(`SELECT ${COLUMNS} FROM message_attachments WHERE chat_id = ? AND message_id IS NOT NULL ORDER BY created_at ASC, rowid ASC`)
    .all(chatId);
  const out = new Map<string, StoredAttachment[]>();
  for (const row of rows) {
    const list = out.get(row.message_id!) ?? [];
    list.push(toStored(row));
    out.set(row.message_id!, list);
  }
  return out;
}

/** HD6's Try again: the retried message's files come off it (to be linked to the re-run), and
 *  the ids are returned in order. */
export function unlinkAttachments(messageId: string): string[] {
  const ids = db
    .query<{ id: string }, [string]>("SELECT id FROM message_attachments WHERE message_id = ? ORDER BY created_at ASC, rowid ASC")
    .all(messageId)
    .map((r) => r.id);
  db.query("UPDATE message_attachments SET message_id = NULL WHERE message_id = ?").run(messageId);
  return ids;
}

/** Rows for messages being deleted; returns their paths so the caller can remove the files. */
export function deleteAttachmentsForMessage(messageId: string): string[] {
  const paths = db
    .query<{ path: string }, [string]>("SELECT path FROM message_attachments WHERE message_id = ?")
    .all(messageId)
    .map((r) => r.path);
  db.query("DELETE FROM message_attachments WHERE message_id = ?").run(messageId);
  return paths;
}
