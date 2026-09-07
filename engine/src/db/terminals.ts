import type { TerminalDTO, TerminalOwner, TerminalStatus } from "@rama/protocol";
import { readBlob, writeBlob } from "../blobs";
import { db } from "./index";
import { newId } from "./ids";

// docs/MISSION_CONTROL_PLAN.md §5.1 — same inline/blob split as db/artifacts.ts's storeBody, and
// the same MAX_TERMINAL_BODY_BYTES cap that constant's own comment already named this table for.
// Kept as a separate copy rather than importing artifacts.ts's private helpers — the two tables'
// storage strategies are meant to stay identical, not entangled.
const INLINE_THRESHOLD = 4096;
const MAX_SCROLLBACK_BYTES = 200_000;

interface TerminalRow {
  id: string;
  project_id: string;
  title: string;
  cwd: string;
  shell: string;
  argv_json: string;
  owner: TerminalOwner;
  origin_chat_id: string | null;
  status: TerminalStatus;
  exit_code: number | null;
  scrollback_hash: string | null;
  scrollback_inline: string | null;
  size: number;
  created_at: number;
  updated_at: number;
}

function toDTO(row: TerminalRow): TerminalDTO {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    cwd: row.cwd,
    shell: row.shell,
    argv: JSON.parse(row.argv_json),
    owner: row.owner,
    originChatId: row.origin_chat_id,
    status: row.status,
    exitCode: row.exit_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const TERMINAL_COLUMNS =
  "id, project_id, title, cwd, shell, argv_json, owner, origin_chat_id, status, exit_code, scrollback_hash, scrollback_inline, size, created_at, updated_at";

export interface CreateTerminalRowInput {
  id?: string;
  projectId: string;
  title: string;
  cwd: string;
  shell: string;
  argv?: string[];
  owner?: TerminalOwner;
  originChatId?: string | null;
}

export function createTerminal(input: CreateTerminalRowInput): TerminalDTO {
  const id = input.id ?? newId();
  const now = Date.now();
  db.query(
    `INSERT INTO terminals (id, project_id, title, cwd, shell, argv_json, owner, origin_chat_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
  ).run(
    id,
    input.projectId,
    input.title,
    input.cwd,
    input.shell,
    JSON.stringify(input.argv ?? []),
    input.owner ?? "user",
    input.originChatId ?? null,
    now,
    now,
  );
  return getTerminal(id)!;
}

export function getTerminal(id: string): TerminalDTO | null {
  const row = db.query<TerminalRow, [string]>(`SELECT ${TERMINAL_COLUMNS} FROM terminals WHERE id = ?`).get(id);
  return row ? toDTO(row) : null;
}

export function listTerminalsByProject(projectId: string): TerminalDTO[] {
  const rows = db
    .query<TerminalRow, [string]>(`SELECT ${TERMINAL_COLUMNS} FROM terminals WHERE project_id = ? ORDER BY created_at ASC`)
    .all(projectId);
  return rows.map(toDTO);
}

export function renameTerminal(id: string, title: string): TerminalDTO | null {
  if (!getTerminal(id)) return null;
  db.query("UPDATE terminals SET title = ?, updated_at = ? WHERE id = ?").run(title, Date.now(), id);
  return getTerminal(id);
}

export function markTerminalExited(id: string, exitCode: number): TerminalDTO | null {
  if (!getTerminal(id)) return null;
  db.query("UPDATE terminals SET status = 'exited', exit_code = ?, updated_at = ? WHERE id = ?").run(
    exitCode,
    Date.now(),
    id,
  );
  return getTerminal(id);
}

export function deleteTerminal(id: string): boolean {
  if (!getTerminal(id)) return false;
  db.query("DELETE FROM terminals WHERE id = ?").run(id);
  return true;
}

export function getScrollback(id: string): string | null {
  const row = db
    .query<Pick<TerminalRow, "scrollback_hash" | "scrollback_inline">, [string]>(
      "SELECT scrollback_hash, scrollback_inline FROM terminals WHERE id = ?",
    )
    .get(id);
  if (!row) return null;
  if (row.scrollback_inline !== null) return row.scrollback_inline;
  if (row.scrollback_hash) return readBlob(row.scrollback_hash);
  return "";
}

// Re-stores the full (possibly trailing-truncated) scrollback on every call, mirroring
// db/artifacts.ts's appendArtifactBody — the useTerminalSession.ts flush interval calls this
// periodically so a reload/reattach mid-session still has recent output to replay.
export function appendScrollback(id: string, delta: string): void {
  const current = getScrollback(id) ?? "";
  let next = current + delta;
  if (Buffer.byteLength(next) > MAX_SCROLLBACK_BYTES) {
    next = `… truncated …\n${next.slice(-MAX_SCROLLBACK_BYTES)}`;
  }
  const size = Buffer.byteLength(next);
  const inline = size < INLINE_THRESHOLD;
  const scrollbackInline = inline ? next : null;
  const scrollbackHash = inline ? null : writeBlob(next).hash;
  db.query(
    "UPDATE terminals SET scrollback_hash = ?, scrollback_inline = ?, size = ?, updated_at = ? WHERE id = ?",
  ).run(scrollbackHash, scrollbackInline, size, Date.now(), id);
}
