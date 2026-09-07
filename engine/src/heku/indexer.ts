import { connectServer } from "../mcp/client";
import { getConnection } from "../mcp/registry";
import { listMcpServers } from "../mcp/store";
import type { McpServerRow } from "../mcp/types";
import { upsertTool } from "./store";

// Third-party MCP descriptions are wildly inconsistent (§7.2) — this is the one normalisation
// pass they get, matching the existing mcp/registry.ts fallback for a missing description.
function normalizeDescription(description: string | undefined, toolName: string, serverName: string): string {
  const trimmed = description?.trim();
  return trimmed || `${toolName} (via ${serverName})`;
}

export interface IndexResult {
  ok: boolean;
  count: number;
  error?: string;
}

// Reuses a live connection if the server already has one (the common case today, since
// mcp/registry.ts's connectAll() still connects every enabled server at boot — see TL7's
// documented lazy-connect scoping in docs/TOOL_LAYER_PLAN.md §7.4); otherwise opens a throwaway
// connection just long enough to list tools, mirroring mcp/health.ts's checkMcpServerHealth
// pattern. Never throws — a server that can't be reached indexes as "0 tools, error", which
// heku_find surfaces as a degraded server rather than failing the whole run (exit criteria: "a
// crashed server degrades search instead of breaking the run").
export async function indexServer(row: McpServerRow): Promise<IndexResult> {
  const existing = getConnection(row.id);
  const client = existing?.client ?? (await connectServer(row).catch(() => null));
  if (!client) return { ok: false, count: 0, error: "could not connect" };

  try {
    const { tools } = await client.listTools();
    const now = Date.now();
    for (const t of tools) {
      upsertTool({
        full_id: `${row.id}.${t.name}`,
        server_id: row.id,
        server_name: row.name,
        tool_name: t.name,
        description: normalizeDescription(t.description, t.name, row.name),
        // §7.2 "Treating all MCP as high today is the right instinct; the gateway is where it
        // becomes granular without becoming scattered" — policy.ts's per-tool override map is the
        // granular path; the index itself always writes the conservative default.
        schema_json: JSON.stringify(t.inputSchema ?? {}),
        risk: "high",
        indexed_at: now,
      });
    }
    return { ok: true, count: tools.length };
  } catch (err) {
    return { ok: false, count: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!existing) await client.close().catch(() => {});
  }
}

// Best-effort across every enabled server, same fire-and-forget framing as mcp/registry.ts's
// connectAll() — one unreachable server must not stop the rest from indexing.
export async function indexAll(): Promise<void> {
  const rows = listMcpServers().filter((r) => r.enabled);
  await Promise.all(
    rows.map(async (row) => {
      const result = await indexServer(row);
      if (!result.ok) {
        console.error(`[heku] failed to index server "${row.name}":`, result.error);
      }
    }),
  );
}
