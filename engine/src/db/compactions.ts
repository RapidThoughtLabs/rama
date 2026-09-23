// engine/src/db/compactions.ts
//
// docs/CONTEXT_BUDGET_PLAN.md CB2 — persists compaction verdicts so buildTranscriptFromDb can
// project them back on every future load without a live in-memory Transcript. D1: this table
// never touches messages/tool_calls content, only records the decision.

import { db } from "./index";
import { newId } from "./ids";
import type { CompactionFields } from "../agent/run/transcript";

export interface CompactionRow {
  id: string;
  chatId: string;
  /** Highest messages.seq this compaction covers (inclusive). */
  boundarySeq: number;
  fields: CompactionFields;
  coveredIds: string[];
  createdAt: number;
}

interface RawCompactionRow {
  id: string;
  chat_id: string;
  boundary_seq: number;
  fields_json: string;
  covered_ids_json: string;
  created_at: number;
}

function toRow(row: RawCompactionRow): CompactionRow {
  return {
    id: row.id,
    chatId: row.chat_id,
    boundarySeq: row.boundary_seq,
    fields: JSON.parse(row.fields_json) as CompactionFields,
    coveredIds: JSON.parse(row.covered_ids_json) as string[],
    createdAt: row.created_at,
  };
}

export function createCompaction(input: {
  chatId: string;
  boundarySeq: number;
  fields: CompactionFields;
  coveredIds: string[];
}): CompactionRow {
  const id = newId();
  const createdAt = Date.now();
  db.query(
    `INSERT INTO compactions (id, chat_id, boundary_seq, fields_json, covered_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, input.chatId, input.boundarySeq, JSON.stringify(input.fields), JSON.stringify(input.coveredIds), createdAt);
  return { id, chatId: input.chatId, boundarySeq: input.boundarySeq, fields: input.fields, coveredIds: input.coveredIds, createdAt };
}

// buildTranscriptFromDb only ever needs the most recent compaction: each new compaction
// summarizes everything not yet summarized plus the previous summary's own text
// (compact.ts's "Previous Summary: ..." feed), so a later row's boundary is always a superset of
// an earlier one's — the latest row alone determines the projection.
export function getLatestCompaction(chatId: string): CompactionRow | null {
  const row = db
    .query<RawCompactionRow, [string]>(
      `SELECT id, chat_id, boundary_seq, fields_json, covered_ids_json, created_at
       FROM compactions WHERE chat_id = ? ORDER BY boundary_seq DESC, created_at DESC LIMIT 1`,
    )
    .get(chatId);
  return row ? toRow(row) : null;
}
