import { connectAndRegister, getConnection, normalizeCallToolResult } from "../mcp/registry";
import { getMcpServer } from "../mcp/store";
import type { ToolResult } from "../tools/types";
import { recordCall, getTool, listAllTools } from "./store";
import type { HekuToolRow } from "./types";

// §7.8 — real embeddings need a bundled sentence model (~50MB) this repo doesn't ship yet; this
// lexical scorer is a documented stand-in (same "scoped, not blocked" treatment as TL6's C9
// deferral), good enough for the corpus size (hundreds of short strings) this is meant to search.
const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "for", "in", "on", "with", "and", "or", "is", "it", "this", "that", "me", "my",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function scoreTool(queryTokens: string[], row: HekuToolRow): number {
  const name = row.tool_name.toLowerCase();
  const description = row.description.toLowerCase();
  const nameTokens = new Set(tokenize(row.tool_name));
  let score = 0;
  for (const qt of queryTokens) {
    if (nameTokens.has(qt)) score += 3;
    else if (name.includes(qt)) score += 1.5;
    if (description.includes(qt)) score += 1;
  }
  return score;
}

export interface RankedTool {
  row: HekuToolRow;
  score: number;
  connected: boolean;
}

export function findTools(intent: string, limit = 5): RankedTool[] {
  const queryTokens = tokenize(intent);
  const all = listAllTools();
  const ranked = all
    .map((row) => ({ row, score: queryTokens.length ? scoreTool(queryTokens, row) : 1, connected: !!getConnection(row.server_id) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return ranked;
}

// §7.7 — "Fifty tokens instead of twenty thousand." One line per server, sampled tool names
// rather than true semantic categories (another documented stand-in for what the plan's example
// implies would need either hand-curated per-server copy or a categorisation LLM call — neither
// of which belongs in a function called on every turn).
export function buildManifest(): string {
  const all = listAllTools();
  if (all.length === 0) return "";

  const byServer = new Map<string, HekuToolRow[]>();
  for (const row of all) {
    const list = byServer.get(row.server_id) ?? [];
    list.push(row);
    byServer.set(row.server_id, list);
  }

  const lines = [...byServer.values()].map((tools) => {
    const names = tools.slice(0, 4).map((t) => t.tool_name).join(", ");
    const more = tools.length > 4 ? `, +${tools.length - 4} more` : "";
    return `  ${tools[0].server_name} — ${names}${more}`;
  });

  return `\n\nExternal capabilities (search with heku_find, call with heku_call):\n${lines.join("\n")}`;
}

function jsonSchemaType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

// Validates before dispatch (§7.5) — a nested-JSON call loses the provider's own schema
// validation on the inner args (§7.3), so heku has to do this itself and return errors the model
// can act on (T3) instead of forwarding a malformed call to the server.
export function validateArgs(schemaJson: string, args: Record<string, unknown>): string[] {
  let schema: { required?: unknown; properties?: Record<string, { type?: unknown }> };
  try {
    schema = JSON.parse(schemaJson);
  } catch {
    return [];
  }
  const errors: string[] = [];
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  for (const key of required) {
    if (args[key] === undefined) errors.push(`"${key}" is required`);
  }
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(args)) {
    const expected = properties[key]?.type;
    if (typeof expected !== "string") continue;
    const actual = jsonSchemaType(value);
    const matches = expected === actual || (expected === "integer" && actual === "number");
    if (!matches) errors.push(`"${key}" should be ${expected}, got ${actual}`);
  }
  return errors;
}

// Lazy connect (§7.4/§7.1 exit criteria) — the only place in TL7 that opens a *persistent*
// connection on demand rather than requiring one to already exist. mcp/registry.ts's connectAll()
// still connects every enabled server eagerly at boot (unchanged — see docs/TOOL_LAYER_PLAN.md
// §7.4's scoping note); this is what makes a server that failed to connect at boot, or one added
// while disabled, reachable from a call without restarting the engine.
async function ensureConnected(serverId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  if (getConnection(serverId)) return { ok: true };
  const row = getMcpServer(serverId);
  if (!row) return { ok: false, error: "server no longer configured" };
  try {
    await connectAndRegister(row);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The one dispatch path for both `heku_call` and any promoted first-class tool (promote.ts) —
// same validation, connect, normalise, and call-count bookkeeping either way.
export async function callExternalTool(
  row: HekuToolRow,
  args: Record<string, unknown>,
  options: { toolCallId: string },
): Promise<ToolResult> {
  const errors = validateArgs(row.schema_json, args);
  if (errors.length > 0) {
    return { ok: false, summary: "invalid args", content: `${row.full_id}: ${errors.join("; ")}` };
  }

  const connected = await ensureConnected(row.server_id);
  if (!connected.ok) {
    return {
      ok: false,
      summary: "server unreachable",
      content: `${row.server_name} is not reachable right now (${connected.error}). ${row.tool_name} exists but couldn't be called — try again, or use heku_find to check for an alternative.`,
    };
  }

  const conn = getConnection(row.server_id)!;
  let serverTools: Awaited<ReturnType<typeof conn.client.tools>>;
  try {
    serverTools = await conn.client.tools();
  } catch (err) {
    return { ok: false, summary: "server error", content: `${row.server_name} failed to list its tools: ${err instanceof Error ? err.message : String(err)}` };
  }

  const original = serverTools[row.tool_name];
  if (!original) {
    return {
      ok: false,
      summary: "tool no longer offered",
      content: `${row.server_name} no longer offers "${row.tool_name}" — it may have been renamed or removed. Call heku_find again to refresh.`,
    };
  }

  const result = await original.execute(args, options as Parameters<typeof original.execute>[1]);
  recordCall(row.full_id);
  return normalizeCallToolResult(result as Parameters<typeof normalizeCallToolResult>[0]);
}

export { getTool };
