import type { ArtifactDTO, ArtifactKind } from "@rama/protocol";
import { readBlob, writeBlob } from "../blobs";
import { db } from "./index";
import { newId } from "./ids";

// Bodies under this size are stored directly in the row; larger ones go to the
// content-addressed blob store (~/.rama/blobs/) instead.
const INLINE_THRESHOLD = 4096;

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

// `id` can be pre-minted by a caller that already broadcast `artifact.created` with it before
// the body was ready (bash streams live, then persists once at the end — see agent/loop.ts).
export function createArtifact(input: CreateArtifactInput): ArtifactDTO {
  const id = input.id ?? newId();
  const now = Date.now();
  const size = Buffer.byteLength(input.body);
  const inline = size < INLINE_THRESHOLD;
  const bodyInline = inline ? input.body : null;
  const bodyHash = inline ? null : writeBlob(input.body).hash;

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
