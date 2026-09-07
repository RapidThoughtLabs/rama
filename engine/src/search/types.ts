// rama search (docs/IMPLEMENTATION_PLAN.md Phase 6) — a native harness-level search seam. heku
// (docs/TOOL_LAYER_PLAN.md §7, TL7) is an in-process broker, not a standalone MCP server, and it
// registers here as the provider for the "mcp" domain (engine/src/search/providers/mcp.ts) —
// exactly the "teammate's embeddings-based indexer" this file anticipated below. Each domain
// (tools, skills, mcp, docs, commands today; memories/chats/files later) registers a
// SearchProvider here.
// `list()` is the required seam — enumerate everything in the domain — so the registry's generic
// scorer can fall back to it. `search()` is an optional override for a provider that wants real
// ranking (e.g. a teammate's embeddings-based indexer) instead of the generic substring scorer.

export interface SearchResultItem {
  id: string;
  domain: string;
  title: string;
  subtitle?: string;
  score: number;
}

export interface SearchCtx {
  projectId?: string;
  projectPath?: string;
}

export interface SearchProvider {
  domain: string;
  label: string;
  list(ctx: SearchCtx): SearchResultItem[] | Promise<SearchResultItem[]>;
  search?(query: string, ctx: SearchCtx): SearchResultItem[] | Promise<SearchResultItem[]>;
}
