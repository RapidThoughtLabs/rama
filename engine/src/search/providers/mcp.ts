import { listConnections } from "../../mcp/registry";
import type { SearchProvider, SearchResultItem } from "../types";

export const mcpSearchProvider: SearchProvider = {
  domain: "mcp",
  label: "MCP",
  async list(): Promise<SearchResultItem[]> {
    const out: SearchResultItem[] = [];
    for (const { row, client } of listConnections()) {
      const { tools } = await client.listTools().catch(() => ({ tools: [] as { name: string; description?: string }[] }));
      for (const t of tools) {
        out.push({
          id: `mcp:${row.id}:${t.name}`,
          domain: "mcp",
          title: t.name,
          subtitle: `${row.name} · ${t.description ?? ""}`.trim(),
          score: 0,
        });
      }
    }
    return out;
  },
};
