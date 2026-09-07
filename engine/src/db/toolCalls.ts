import type { ToolCallDTO } from "@rama/protocol";
import { db } from "./index";

interface ToolCallRow {
  id: string;
  message_id: string;
  chat_id: string;
  name: string;
  input_json: string;
  ok: number | null;
  result_summary: string | null;
  started_at: number | null;
  ended_at: number | null;
  artifact_id: string | null;
}

function toDTO(row: ToolCallRow): ToolCallDTO {
  return {
    id: row.id,
    messageId: row.message_id,
    chatId: row.chat_id,
    name: row.name,
    input: JSON.parse(row.input_json),
    ok: row.ok === null ? null : row.ok === 1,
    resultSummary: row.result_summary,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    artifactId: row.artifact_id,
  };
}

export function createToolCall(input: {
  id: string;
  messageId: string;
  chatId: string;
  name: string;
  input: unknown;
  startedAt: number;
}): void {
  db.query(
    `INSERT INTO tool_calls (id, message_id, chat_id, name, input_json, ok, result_summary, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL)`,
  ).run(input.id, input.messageId, input.chatId, input.name, JSON.stringify(input.input), input.startedAt);
}

// `artifacts.tool_call_id` (set when the tool creates one) is how a call links back to its
// artifact — there's no dedicated column on tool_calls for it, just the join below.
export function finalizeToolCall(
  id: string,
  result: {
    ok: boolean;
    resultSummary: string;
    resultContent?: string | null;
    resultMeta?: Record<string, unknown> | null;
    endedAt: number;
  },
): void {
  db.query(
    "UPDATE tool_calls SET ok = ?, result_summary = ?, result_content = ?, result_meta_json = ?, ended_at = ? WHERE id = ?",
  ).run(
    result.ok ? 1 : 0,
    result.resultSummary,
    result.resultContent ?? null,
    result.resultMeta ? JSON.stringify(result.resultMeta) : null,
    result.endedAt,
    id,
  );
}

export interface ToolCallHistoryEntry {
  id: string;
  messageId: string;
  name: string;
  input: unknown;
  ok: boolean;
  resultContent: string | null;
  resultSummary: string | null;
}

interface ToolCallHistoryRow {
  id: string;
  message_id: string;
  name: string;
  input_json: string;
  ok: number;
  result_content: string | null;
  result_summary: string | null;
}

// Feeds the model-message reconstruction in agent/loop.ts, not the wire DTO — only finalized
// calls (ok IS NOT NULL) are eligible: a call still in flight when its run got interrupted has no
// result to pair with its tool-call part, and replaying it unpaired would violate every
// provider's tool_use/tool_result matching requirement on the next turn.
export function listToolCallsForHistory(chatId: string): ToolCallHistoryEntry[] {
  const rows = db
    .query<
      ToolCallHistoryRow,
      [string]
    >(`SELECT id, message_id, name, input_json, ok, result_content, result_summary
       FROM tool_calls WHERE chat_id = ? AND ok IS NOT NULL ORDER BY started_at ASC`)
    .all(chatId);
  return rows.map((row) => ({
    id: row.id,
    messageId: row.message_id,
    name: row.name,
    input: JSON.parse(row.input_json),
    ok: row.ok === 1,
    resultContent: row.result_content,
    resultSummary: row.result_summary,
  }));
}

const SELECT_WITH_ARTIFACT = `
  SELECT tc.id, tc.message_id, tc.chat_id, tc.name, tc.input_json, tc.ok, tc.result_summary, tc.started_at, tc.ended_at,
         a.id AS artifact_id
  FROM tool_calls tc
  LEFT JOIN artifacts a ON a.tool_call_id = tc.id
`;

export function listToolCalls(chatId: string): ToolCallDTO[] {
  const rows = db
    .query<ToolCallRow, [string]>(`${SELECT_WITH_ARTIFACT} WHERE tc.chat_id = ? ORDER BY tc.started_at ASC`)
    .all(chatId);
  return rows.map(toDTO);
}
