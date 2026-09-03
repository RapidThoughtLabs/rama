import { db } from "../db/index";
import { newId } from "../db/ids";
import type { McpServerRow, McpTransportConfig } from "./types";

export function listMcpServers(): McpServerRow[] {
  return db.query<McpServerRow, []>("SELECT * FROM mcp_servers ORDER BY created_at ASC").all();
}

export function getMcpServer(id: string): McpServerRow | null {
  return db.query<McpServerRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
}

export function insertMcpServer(input: { name: string; transport: McpTransportConfig }): McpServerRow {
  const id = newId();
  const createdAt = Date.now();
  const transportJson = JSON.stringify(input.transport);
  db.query(
    "INSERT INTO mcp_servers (id, name, transport_json, enabled, created_at) VALUES (?, ?, ?, 1, ?)",
  ).run(id, input.name, transportJson, createdAt);
  return { id, name: input.name, transport_json: transportJson, enabled: 1, created_at: createdAt };
}

export function deleteMcpServer(id: string): boolean {
  const result = db.query("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return result.changes > 0;
}

export function setMcpServerEnabled(id: string, enabled: boolean): McpServerRow | null {
  db.query("UPDATE mcp_servers SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  return getMcpServer(id);
}
