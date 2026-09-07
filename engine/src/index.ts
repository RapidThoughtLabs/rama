// Bun sidecar daemon (docs/IMPLEMENTATION_PLAN.md Phase 1). Rust core spawns this process and
// reads the first stdout line as JSON `{ engineUrl, token }` to hand the webview a connection.

import { ENGINE_TOKEN } from "./auth";
import { indexAll } from "./heku/indexer";
import { connectAll } from "./mcp/registry";
import { registerSearchProvider } from "./search/registry";
import { commandsSearchProvider } from "./search/providers/commands";
import { docsSearchProvider } from "./search/providers/docs";
import { mcpSearchProvider } from "./search/providers/mcp";
import { skillsSearchProvider } from "./search/providers/skills";
import { toolsSearchProvider } from "./search/providers/tools";
import { createServer } from "./server";

registerSearchProvider(toolsSearchProvider);
registerSearchProvider(skillsSearchProvider);
registerSearchProvider(mcpSearchProvider);
registerSearchProvider(docsSearchProvider);
registerSearchProvider(commandsSearchProvider);

// Fire-and-forget, not awaited: one slow/unreachable MCP server must not delay engine boot. Its
// tools simply aren't in the loop/search results yet until the connection resolves. indexAll()
// runs after connectAll() so it can reuse the connections it just opened rather than dialling
// each server twice — docs/TOOL_LAYER_PLAN.md §7.4's heku_tools index, which heku_find/heku_call
// and the "mcp" search domain both read instead of a live connection.
void connectAll().then(() => indexAll());

const server = createServer();
const engineUrl = `http://127.0.0.1:${server.port}`;

console.log(JSON.stringify({ engineUrl, token: ENGINE_TOKEN }));
console.log(`[rama/engine] listening on ${engineUrl}`);
