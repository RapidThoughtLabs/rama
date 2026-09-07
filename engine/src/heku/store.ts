import { db } from "../db/index";
import type { HekuToolRow } from "./types";

// Preserves call_count/last_called_at/pinned across re-index — indexer.ts calls this every time
// it pulls a server's tool list (on connect, on manual re-index), and usage history/pins must
// survive that, not reset to zero every time a server reconnects.
export function upsertTool(row: Omit<HekuToolRow, "pinned" | "call_count" | "last_called_at">): void {
  db.query(
    `INSERT INTO heku_tools (full_id, server_id, server_name, tool_name, description, schema_json, risk, indexed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(full_id) DO UPDATE SET
       server_name = excluded.server_name,
       description = excluded.description,
       schema_json = excluded.schema_json,
       risk = excluded.risk,
       indexed_at = excluded.indexed_at`,
  ).run(row.full_id, row.server_id, row.server_name, row.tool_name, row.description, row.schema_json, row.risk, row.indexed_at);
}

export function getTool(fullId: string): HekuToolRow | null {
  return db.query<HekuToolRow, [string]>("SELECT * FROM heku_tools WHERE full_id = ?").get(fullId);
}

export function listAllTools(): HekuToolRow[] {
  return db.query<HekuToolRow, []>("SELECT * FROM heku_tools ORDER BY server_name ASC, tool_name ASC").all();
}

export function listToolsForServer(serverId: string): HekuToolRow[] {
  return db
    .query<HekuToolRow, [string]>("SELECT * FROM heku_tools WHERE server_id = ? ORDER BY tool_name ASC")
    .all(serverId);
}

// Called when a server is removed entirely (server.ts's DELETE /mcp/servers/:id) — a disconnected
// but still-configured server keeps its index (degraded, not gone); a deleted one shouldn't.
export function deleteToolsForServer(serverId: string): void {
  db.query("DELETE FROM heku_tools WHERE server_id = ?").run(serverId);
}

export function recordCall(fullId: string): void {
  db.query("UPDATE heku_tools SET call_count = call_count + 1, last_called_at = ? WHERE full_id = ?").run(
    Date.now(),
    fullId,
  );
}

export function setPinned(fullId: string, pinned: boolean): void {
  db.query("UPDATE heku_tools SET pinned = ? WHERE full_id = ?").run(pinned ? 1 : 0, fullId);
}
