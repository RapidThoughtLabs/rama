import { defineTool, defineRawTool, type RamaToolSet } from "../tools/define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import type { ToolCtx, ToolResult } from "../tools/types";
import { headTailTruncate } from "../tools/truncate";
import { callExternalTool, findTools, getTool } from "./index";
import { resolveRisk } from "./policy";
import { getPromotedTools } from "./promote";
import type { HekuToolRow } from "./types";

const MODEL_OUTPUT_CHARS = 4_000;

function summarizeSchema(schemaJson: string): string {
  try {
    const schema = JSON.parse(schemaJson) as { properties?: Record<string, unknown>; required?: string[] };
    const properties = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    const keys = Object.keys(properties);
    if (keys.length === 0) return "{}";
    return `{ ${keys.map((k) => (required.has(k) ? k : `${k}?`)).join(", ")} }`;
  } catch {
    return "{}";
  }
}

function formatRankedTool(row: HekuToolRow, connected: boolean): string {
  const risk = resolveRisk(row);
  const status = connected ? "" : " (server currently disconnected — will reconnect on call)";
  return `${row.full_id}  (risk: ${risk})${status}\n  ${row.description}\n  args: ${summarizeSchema(row.schema_json)}`;
}

// docs/TOOL_LAYER_PLAN.md §7 (TL7) — the two-slot gateway that replaces mcp/registry.ts's
// getServerTools flattening. Plus one real tool() entry per promoted tool (§7.6), generated fresh
// each call since promotion is a live view over call_count/pinned, not a stored tool set.
export function createHekuTools(ctx: ToolCtx): RamaToolSet {
  const find = defineTool({
    description:
      "Search external (MCP-connected) tools by what you want to do — \"create a pull request\", " +
      "\"screenshot a page\". Returns ranked matches with full argument schemas, so you can call " +
      "heku_call immediately without a second lookup. Use this instead of guessing a tool exists.",
    inputSchema: z.object({
      intent: z.string().describe('What you want to do, in plain language — "create a pull request", "screenshot a page".'),
      limit: z.number().optional().describe("Default 5."),
    }),
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "heku_find", input, risk: "low" }, async () => {
        const ranked = findTools(input.intent, input.limit ?? 5);
        if (ranked.length === 0) {
          return {
            ok: true,
            summary: "no matches",
            content: `No external tools matched "${input.intent}". Either nothing is connected, or try different words.`,
          };
        }
        const lines = ranked.map((r) => formatRankedTool(r.row, r.connected));
        return {
          ok: true,
          summary: `${ranked.length} match${ranked.length === 1 ? "" : "es"}`,
          content: `${ranked.length} tool${ranked.length === 1 ? "" : "s"} for "${input.intent}":\n\n${lines.join("\n\n")}`,
        };
      }),
  });

  const call = defineTool({
    description:
      "Call an external tool found via heku_find. `tool` must be the exact full_id it returned " +
      "(e.g. github.create_pull_request). Validates args against the tool's real schema before " +
      "dispatching and connects to its server on demand if it isn't already connected.",
    inputSchema: z.object({
      tool: z.string().describe("Exact id from heku_find, e.g. github.create_pull_request"),
      args: z.record(z.string(), z.unknown()),
    }),
    execute: async (input, options): Promise<ToolResult> => {
      const row = getTool(input.tool);
      const risk = row ? resolveRisk(row) : "high";
      return gate(ctx, { name: "heku_call", input, risk }, async () => {
        if (!row) {
          return {
            ok: false,
            summary: "unknown tool",
            content: `No external tool named "${input.tool}". Call heku_find first to get the exact full_id.`,
          };
        }
        const result = await callExternalTool(row, input.args as Record<string, unknown>, { toolCallId: options.toolCallId });
        if (!result.content) return result;

        const { content, truncated } = headTailTruncate(result.content, MODEL_OUTPUT_CHARS);
        const artifactId = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "doc",
          name: `heku_call: ${input.tool}`,
          meta: { externalTool: { server: row.server_name, tool: row.tool_name } },
          body: result.content,
        }).id;

        return {
          ...result,
          content,
          artifactId,
          meta: {
            ...result.meta,
            externalTool: { server: row.server_name, tool: row.tool_name },
            ...(truncated
              ? { truncated: { shown: MODEL_OUTPUT_CHARS, total: result.content.length, unit: "bytes" as const, how: "head+tail: see the full result in the artifacts panel" } }
              : {}),
          },
        };
      });
    },
  });

  const out: RamaToolSet = { heku_find: find, heku_call: call };

  // §7.6 — a real tool() per promoted row, sharing callExternalTool's exact dispatch path so a
  // promoted call behaves identically to heku_call, just without the two-step indirection.
  for (const row of getPromotedTools()) {
    const name = `${sanitizeName(row.server_name)}_${sanitizeName(row.tool_name)}`;
    // Real JSON Schema from the MCP server, not zod — jsonSchema() is the AI SDK's own escape
    // hatch for this, matching the existing SDK-interop cast precedent in mcp/registry.ts's old
    // getServerTools (a Tool's inputSchema is a data shape at runtime, not a compile-time zod type).
    let parsedSchema: Record<string, unknown>;
    try {
      parsedSchema = JSON.parse(row.schema_json);
    } catch {
      parsedSchema = { type: "object" };
    }
    out[name] = defineRawTool({
      description: `${row.description} (promoted external tool, via ${row.server_name})`,
      jsonSchema: parsedSchema,
      execute: async (input: unknown, options): Promise<ToolResult> =>
        gate(ctx, { name, input, risk: resolveRisk(row) }, async () => {
          const result = await callExternalTool(row, input as Record<string, unknown>, { toolCallId: options.toolCallId });
          if (!result.content) return result;
          const { content, truncated } = headTailTruncate(result.content, MODEL_OUTPUT_CHARS);
          return {
            ...result,
            content,
            ...(truncated ? { meta: { ...result.meta, truncated: { shown: MODEL_OUTPUT_CHARS, total: result.content.length, unit: "bytes" as const, how: "call the tool again with narrower args" } } } : {}),
          };
        }),
    });
  }

  return out;
}

function sanitizeName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "tool";
}
