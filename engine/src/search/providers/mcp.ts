// docs/TOOL_LAYER_PLAN.md §7.4 — "Reuse the existing search seam... heku registers as the
// provider for the external-tools domain. The palette and the model then share one index." Reads
// the persisted heku_tools index instead of calling out to every live connection on every
// keystroke — the same source heku_find ranks against, and it works for a disconnected server too
// (degraded, not empty — the exit criteria's "a crashed server degrades search").
import { listAllTools } from "../../heku/store";
import type { SearchProvider, SearchResultItem } from "../types";

export const mcpSearchProvider: SearchProvider = {
  domain: "mcp",
  label: "MCP",
  list(): SearchResultItem[] {
    return listAllTools().map((row) => ({
      id: `mcp:${row.full_id}`,
      domain: "mcp",
      title: row.tool_name,
      subtitle: `${row.server_name} · ${row.description}`.trim(),
      score: 0,
    }));
  },
};
