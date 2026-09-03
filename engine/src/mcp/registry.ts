import type { ToolSet } from "ai";
import type { CallToolResult } from "@ai-sdk/mcp";
import { gate } from "../agent/permissions";
import type { ToolCtx, ToolResult } from "../tools/types";
import { connectServer } from "./client";
import { listMcpServers } from "./store";
import type { McpServerRow } from "./types";

const connections = new Map<string, { client: Awaited<ReturnType<typeof connectServer>>; row: McpServerRow }>();

function sanitize(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

function normalizeCallToolResult(result: CallToolResult): ToolResult {
  if ("toolResult" in result) {
    return { ok: true, summary: "done", detail: JSON.stringify(result.toolResult) };
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
    detail: text || undefined,
  };
}

// Best-effort: one bad MCP server config must not block engine startup. Failures are logged and
// that server is simply absent from getServerTools()/the mcp search domain until reconnected.
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

// Flattens every connected server's tools into the per-turn tool set, renamed mcp_<server>_<tool>
// so they can never collide with builtins (unprefixed) or skills (skill_*). Every MCP tool is
// treated as "high" risk — external/untrusted by default, same trust tier as bash.
export async function getServerTools(ctx: ToolCtx): Promise<ToolSet> {
  const out: ToolSet = {};

  for (const { client, row } of connections.values()) {
    let serverTools: Awaited<ReturnType<typeof client.tools>>;
    try {
      serverTools = await client.tools();
    } catch (err) {
      console.error(`[mcp] failed to list tools for "${row.name}":`, err instanceof Error ? err.message : err);
      continue;
    }

    for (const [toolName, original] of Object.entries(serverTools)) {
      const name = `mcp_${sanitize(row.name)}_${sanitize(toolName)}`;
      // Built as a plain object rather than run back through tool() — the MCP tool's own
      // inputSchema/execute generics don't line up with tool()'s overload inference (INPUT is
      // "unknown" here, not a concrete zod shape), and a Tool is just a data shape at runtime.
      // One cast at this SDK-interop boundary instead of fighting generics that don't apply.
      out[name] = {
        description: typeof original.description === "string" ? original.description : `${toolName} (via ${row.name})`,
        inputSchema: original.inputSchema,
        execute: async (input: unknown, options: unknown): Promise<ToolResult> =>
          gate(ctx, { name, input, risk: "high" }, async () => {
            const result = await original.execute(input, options as Parameters<typeof original.execute>[1]);
            return normalizeCallToolResult(result as CallToolResult);
          }),
      } as unknown as ToolSet[string];
    }
  }

  return out;
}
