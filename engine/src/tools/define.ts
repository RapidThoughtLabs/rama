// engine/src/tools/define.ts
//
// Rama's own tool definition helpers — replaces `tool()` and `jsonSchema()` from "ai".
// docs/LOOP_MIGRATION_PLAN.md §6.2
//
// Chosen to be signature-identical to what the 29 `tool({...})` call sites already pass,
// so LM1 is an import-line change in 22 files and nothing more.
//
// `options.toolCallId` is the only execute-context field any tool uses (10 sites,
// all createArtifact) — everything else in the SDK's options object is unused.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Context passed to every tool's execute function. */
export interface ToolExecuteOptions {
  /** The unique call id emitted by the model, passed through to createArtifact and DB. */
  toolCallId: string;
}

/** A resolved tool definition ready for use by the loop. */
export interface RamaTool {
  description: string;
  /**
   * Fully-resolved JSON Schema (draft-2020-12), computed once at definition time.
   * Used by the encoder to describe the tool to the model.
   */
  inputSchema: Record<string, unknown>;
  execute: (input: unknown, options: ToolExecuteOptions) => Promise<unknown>;
}

/** A named set of tools, keyed by tool name. Replaces `ToolSet` from "ai". */
export type RamaToolSet = Record<string, RamaTool>;

// ---------------------------------------------------------------------------
// defineTool — for tools with a zod schema (all harness tools)
// ---------------------------------------------------------------------------

export interface DefineToolSpec<S extends z.ZodType> {
  description: string;
  inputSchema: S;
  execute: (input: z.infer<S>, options: ToolExecuteOptions) => Promise<unknown>;
}

/**
 * Define a tool with a zod input schema. The schema is converted to JSON Schema
 * once at definition time and cached on the returned RamaTool.
 *
 * Validation is performed by the loop-side wrapper before execute() is called:
 * if the model's arguments fail zod parsing, the tool returns ok:false with the
 * zod error message as content — strictly better than the SDK's tool-error throw.
 * docs/LOOP_MIGRATION_PLAN.md §6.2
 *
 * Note on strict mode: zod 4 emits `additionalProperties: false`, which OpenAI's
 * strict function-calling requires but some OpenAI-compatible vendors reject.
 * The encoder strips it per catalog field if a vendor is known to choke (§4.6 rule 6).
 */
export function defineTool<S extends z.ZodType>(spec: DefineToolSpec<S>): RamaTool {
  // zod 4's toJSONSchema emits draft-2020-12 with description, required, and
  // additionalProperties: false intact. Verified against zod@^4.4.3.
  const schemaObj = z.toJSONSchema(spec.inputSchema) as Record<string, unknown>;
  return {
    description: spec.description,
    inputSchema: schemaObj,
    execute: async (rawInput: unknown, options: ToolExecuteOptions): Promise<unknown> => {
      const parsed = spec.inputSchema.safeParse(rawInput);
      if (!parsed.success) {
        const errorMsg = parsed.error.issues
          .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
          .join("; ");
        return {
          ok: false,
          summary: "invalid tool arguments",
          content: `Invalid arguments: ${errorMsg}`,
        };
      }
      return spec.execute(parsed.data, options);
    },
  };
}

// ---------------------------------------------------------------------------
// defineRawTool — for tools with a raw JSON Schema (heku promoted MCP tools)
// ---------------------------------------------------------------------------

export interface DefineRawToolSpec {
  description: string;
  /** Real JSON Schema, not zod. Used by heku's promoted MCP tools (the only jsonSchema() site). */
  jsonSchema: Record<string, unknown>;
  execute: (input: unknown, options: ToolExecuteOptions) => Promise<unknown>;
}

/**
 * Define a tool with a raw JSON Schema (not zod). Used by heku/tools.ts for
 * promoted MCP tools whose schema comes from the MCP server, not a zod definition.
 * Replaces `jsonSchema()` from "ai".
 * docs/LOOP_MIGRATION_PLAN.md §6.2
 */
export function defineRawTool(spec: DefineRawToolSpec): RamaTool {
  return {
    description: spec.description,
    inputSchema: spec.jsonSchema,
    execute: spec.execute,
  };
}
