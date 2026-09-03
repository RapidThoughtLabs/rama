import type { ArtifactDTO, ArtifactKind } from "@rama/protocol";
import { readBlob, writeBlob } from "../blobs";
import { db } from "./index";
import { newId } from "./ids";

// Bodies under this size are stored directly in the row; larger ones go to the
// content-addressed blob store (~/.rama/blobs/) instead.
const INLINE_THRESHOLD = 4096;

// Trailing cap for incrementally-appended bodies (PTY output) — terminal scrollback is
// inherently boundable, so this keeps only the most recent output rather than growing forever.
const MAX_TERMINAL_BODY_BYTES = 200_000;

interface ArtifactRow {
  id: string;
  chat_id: string;
  project_id: string;
  message_id: string | null;
  tool_call_id: string | null;
  kind: ArtifactKind;
  name: string;
  meta_json: string;
  body_hash: string | null;
  body_inline: string | null;
  size: number;
  status: "streaming" | "done";
  created_at: number;
  updated_at: number;
}

function toDTO(row: ArtifactRow): ArtifactDTO {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    messageId: row.message_id,
    toolCallId: row.tool_call_id,
    kind: row.kind,
    name: row.name,
    meta: JSON.parse(row.meta_json),
    size: row.size,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateArtifactInput {
  id?: string;
  chatId: string;
  projectId: string;
  messageId?: string | null;
  toolCallId?: string | null;
  kind: ArtifactKind;
  name: string;
  meta?: Record<string, unknown>;
  body: string;
  status?: "streaming" | "done";
}

function storeBody(body: string): { bodyHash: string | null; bodyInline: string | null; size: number } {
  const size = Buffer.byteLength(body);
  const inline = size < INLINE_THRESHOLD;
  return { bodyInline: inline ? body : null, bodyHash: inline ? null : writeBlob(body).hash, size };
}

// `id` can be pre-minted by a caller that already broadcast `artifact.created` with it before
// the body was ready (bash streams live, then persists once at the end — see agent/loop.ts).
export function createArtifact(input: CreateArtifactInput): ArtifactDTO {
  const id = input.id ?? newId();
  const now = Date.now();
  const { bodyHash, bodyInline, size } = storeBody(input.body);

  db.query(
    `INSERT INTO artifacts (id, chat_id, project_id, message_id, tool_call_id, kind, name, meta_json, body_hash, body_inline, size, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.chatId,
    input.projectId,
    input.messageId ?? null,
    input.toolCallId ?? null,
    input.kind,
    input.name,
    JSON.stringify(input.meta ?? {}),
    bodyHash,
    bodyInline,
    size,
    input.status ?? "done",
    now,
    now,
  );

  return getArtifact(id)!;
}

export function getArtifact(id: string): ArtifactDTO | null {
  const row = db.query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE id = ?").get(id);
  return row ? toDTO(row) : null;
}

export function listArtifacts(chatId: string): ArtifactDTO[] {
  const rows = db
    .query<ArtifactRow, [string]>("SELECT * FROM artifacts WHERE chat_id = ? ORDER BY created_at DESC")
    .all(chatId);
  return rows.map(toDTO);
}

export function getArtifactContent(id: string): string | null {
  const row = db
    .query<Pick<ArtifactRow, "body_hash" | "body_inline">, [string]>(
      "SELECT body_hash, body_inline FROM artifacts WHERE id = ?",
    )
    .get(id);
  if (!row) return null;
  if (row.body_inline !== null) return row.body_inline;
  if (row.body_hash) return readBlob(row.body_hash);
  return null;
}

// Re-stores the full (possibly trailing-truncated) body on every call — unlike bash.ts's
// write-once artifact, a PTY session's output needs to survive a reload/reopen mid-stream, so
// this is called periodically (see POST /chats/:id/pty/data) rather than only once at the end.
export function appendArtifactBody(id: string, delta: string): void {
  const current = getArtifactContent(id) ?? "";
  let next = current + delta;
  if (Buffer.byteLength(next) > MAX_TERMINAL_BODY_BYTES) {
    next = `… truncated …\n${next.slice(-MAX_TERMINAL_BODY_BYTES)}`;
  }
  const { bodyHash, bodyInline, size } = storeBody(next);
  db.query("UPDATE artifacts SET body_hash = ?, body_inline = ?, size = ?, updated_at = ? WHERE id = ?").run(
    bodyHash,
    bodyInline,
    size,
    Date.now(),
    id,
  );
}

export function finalizeArtifact(id: string, meta?: Record<string, unknown>): void {
  if (meta) {
    db.query("UPDATE artifacts SET status = 'done', meta_json = ?, updated_at = ? WHERE id = ?").run(
      JSON.stringify(meta),
      Date.now(),
      id,
    );
  } else {
    db.query("UPDATE artifacts SET status = 'done', updated_at = ? WHERE id = ?").run(Date.now(), id);
  }
}
