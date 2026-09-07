import type { CallToolResult } from "@ai-sdk/mcp";
import type { ToolResult } from "../tools/types";
import { connectServer } from "./client";
import { listMcpServers } from "./store";
import type { McpServerRow } from "./types";

const connections = new Map<string, { client: Awaited<ReturnType<typeof connectServer>>; row: McpServerRow }>();

// docs/TOOL_LAYER_PLAN.md §7.5 — shared by heku_call and every promoted tool (engine/src/heku/
// index.ts's callExternalTool), not just this module's own former getServerTools.
export function normalizeCallToolResult(result: CallToolResult): ToolResult {
  if ("toolResult" in result) {
    return { ok: true, summary: "done", content: JSON.stringify(result.toolResult) };
  }
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  const ok = !result.isError;
  return {
    ok,
    summary: text ? (text.length > 200 ? `${text.slice(0, 200)}…` : text) : ok ? "done" : "tool error",
    content: text || undefined,
  };
}

// Best-effort: one bad MCP server config must not block engine startup. Failures are logged and
// that server is simply absent from heku's index/the mcp search domain until reconnected.
export async function connectAndRegister(row: McpServerRow): Promise<void> {
  const client = await connectServer(row);
  connections.set(row.id, { client, row });
}

export async function disconnectServer(id: string): Promise<void> {
  const entry = connections.get(id);
  if (!entry) return;
  connections.delete(id);
  await entry.client.close().catch(() => {});
}

export async function connectAll(): Promise<void> {
  const rows = listMcpServers().filter((r) => r.enabled);
  await Promise.all(
    rows.map((row) =>
      connectAndRegister(row).catch((err) => {
        console.error(`[mcp] failed to connect server "${row.name}":`, err instanceof Error ? err.message : err);
      }),
    ),
  );
}

export function listConnections(): { row: McpServerRow; client: Awaited<ReturnType<typeof connectServer>> }[] {
  return [...connections.values()];
}

export function getConnection(id: string) {
  return connections.get(id);
}
