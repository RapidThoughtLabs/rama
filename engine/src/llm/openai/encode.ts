// engine/src/llm/openai/encode.ts
//
// Pure: Rama WireMessage[] + WireTool[] → OpenAI Chat Completions request body.
// No I/O, no side effects — every provider quirk is a unit test against this function.
// docs/LOOP_MIGRATION_PLAN.md §4.2, Decision 5 (annotations ignored here)

import type { WireMessage, WireTool, LlmRequest } from "../types";

/** OpenAI-wire message shape (what actually goes in the JSON body). */
export interface OpenAIMessage {
  role: string;
  content: string | OpenAIContentPart[] | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OpenAIRequestBody {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_completion_tokens?: number;
  temperature?: number;
  stream: true;
  stream_options: { include_usage: true };
}

/** Encode a single WireMessage to OpenAI wire format. */
function encodeMessage(msg: WireMessage): OpenAIMessage {
  const base: OpenAIMessage = { role: msg.role, content: null };

  // Content
  if (typeof msg.content === "string") {
    base.content = msg.content;
  } else if (Array.isArray(msg.content)) {
    base.content = msg.content.map((part) => {
      if (part.type === "text") return { type: "text" as const, text: part.text };
      if (part.type === "image_url") return { type: "image_url" as const, image_url: part.image_url };
      return part;
    });
  }

  // Tool calls (assistant → model)
  if (msg.role === "assistant" && msg.toolCalls && msg.toolCalls.length > 0) {
    base.tool_calls = msg.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
      },
    }));
  }

  // Tool result (tool role)
  if (msg.role === "tool" && msg.toolCallId) {
    base.tool_call_id = msg.toolCallId;
  }

  // Annotations: the OpenAI encoder deliberately ignores all annotation fields.
  // They are for the Anthropic encoder (LM7) only.

  return base;
}

/**
 * Encode a WireTool to OpenAI function-calling format.
 *
 * `strict` is deliberately never emitted: OpenAI's strict mode requires every key in
 * `properties` to also appear in `required` (zod only puts non-optional keys there — Rama's
 * tools have 47 `.optional()` params across the harness) and rejects `$schema` outright.
 * docs/LOOP_MENDING_PLAN.md D4/MD1 — provider divergence belongs in the catalog (a future
 * per-model `strict` flag plus a schema transform that adds every property to `required`),
 * never as an `if (providerId === ...)` here.
 */
function encodeTool(tool: WireTool): OpenAITool {
  const { $schema, ...parameters } = tool.inputSchema;
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters,
    },
  };
}

/**
 * Pure encoder: LlmRequest → OpenAI request body JSON object.
 *
 * Uses `stream: true` and `stream_options: { include_usage: true }` always —
 * the transport is streaming-only (non-streaming is complete.ts's domain).
 */
export function encodeRequest(req: LlmRequest): OpenAIRequestBody {
  const body: OpenAIRequestBody = {
    model: req.model,
    messages: req.messages.map(encodeMessage),
    stream: true,
    stream_options: { include_usage: true },
  };

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(encodeTool);
  }
  if (req.maxOutputTokens != null) {
    body.max_completion_tokens = req.maxOutputTokens;
  }
  if (req.temperature != null) {
    body.temperature = req.temperature;
  }

  return body;
}
