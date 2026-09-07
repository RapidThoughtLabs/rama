import { db } from "./index";

// docs/TOOL_LAYER_PLAN.md §5.1 — one row per (chat, path) the model has read this chat, so the
// read-before-write precondition survives across turns (a plain in-memory Map wouldn't).
interface FileReadRow {
  chat_id: string;
  path: string;
  mtime_ms: number;
  size: number;
  read_at: number;
}

export function upsertFileRead(chatId: string, path: string, mtimeMs: number, size: number, readAt: number): void {
  db.query(
    `INSERT INTO file_reads (chat_id, path, mtime_ms, size, read_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, path) DO UPDATE SET mtime_ms = excluded.mtime_ms, size = excluded.size, read_at = excluded.read_at`,
  ).run(chatId, path, mtimeMs, size, readAt);
}

export function getFileRead(chatId: string, path: string): FileReadRow | null {
  return db.query<FileReadRow, [string, string]>("SELECT * FROM file_reads WHERE chat_id = ? AND path = ?").get(chatId, path);
}

export function deleteFileRead(chatId: string, path: string): void {
  db.query("DELETE FROM file_reads WHERE chat_id = ? AND path = ?").run(chatId, path);
}

export function deleteFileReadsForChat(chatId: string): void {
  db.query("DELETE FROM file_reads WHERE chat_id = ?").run(chatId);
}
