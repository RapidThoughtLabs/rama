// engine/src/llm/anthropic/encode.ts
//
// Pure: Rama WireMessage[] + WireTool[] → Anthropic Messages API request body.
// docs/LOOP_MIGRATION_PLAN.md §4.3, §7 (LM7)
//
// No I/O, no side effects — tested via table-driven fixture tests.

import type { ContentPart, LlmRequest, WireMessage, WireTool } from "../types";

export interface AnthropicCacheControl {
  type: "ephemeral";
}

export type AnthropicContentPart =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string }; cache_control?: AnthropicCacheControl }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown>; cache_control?: AnthropicCacheControl }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: AnthropicCacheControl }
  | { type: "thinking"; thinking: string; signature: string; cache_control?: AnthropicCacheControl };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentPart[];
}

export interface AnthropicSystemPart {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicRequestBody {
  model: string;
  messages: AnthropicMessage[];
  system?: AnthropicSystemPart[];
  tools?: AnthropicTool[];
  max_tokens: number;
  temperature?: number;
  stream: true;
}

function contentPartToAnthropic(part: ContentPart): AnthropicContentPart {
  if (part.type === "text") {
    return { type: "text", text: part.text };
  }
  // Image URL handling (base64 data url or stub)
  const url = part.image_url.url;
  const match = url.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: match[1],
        data: match[2],
      },
    };
  }
  return { type: "text", text: `[Image: ${url}]` };
}

function encodeTool(tool: WireTool): AnthropicTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

// Anthropic accepts at most 4 `cache_control` breakpoints per request. Rama's layout (3 buildPrompt
// system blocks + 1 conversation tail, docs/LOOP_MENDING_PLAN.md G2) sits exactly at that limit by
// design, which means it has no slack: a fifth breakpoint from some future block is a silent
// caching regression (or a live 400) unless something catches it here, at the one place that sees
// the whole request.
const MAX_CACHE_BREAKPOINTS = 4;

function countCacheBreakpoints(body: AnthropicRequestBody): number {
  let count = 0;
  for (const part of body.system ?? []) {
    if (part.cache_control) count++;
  }
  for (const msg of body.messages) {
    for (const part of msg.content) {
      if (part.cache_control) count++;
    }
  }
  return count;
}

/**
 * Pure encoder: LlmRequest → Anthropic request body JSON object.
 */
export function encodeRequest(req: LlmRequest): AnthropicRequestBody {
  const systemParts: AnthropicSystemPart[] = [];
  const rawMessages: AnthropicMessage[] = [];

  for (const msg of req.messages) {
    // 1. System role: extracted into top-level system parameter
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content.map((p) => (p.type === "text" ? p.text : "")).join("\n");
      const part: AnthropicSystemPart = { type: "text", text };
      if (msg.annotations?.cacheBreakpoint) {
        part.cache_control = { type: "ephemeral" };
      }
      systemParts.push(part);
      continue;
    }

    // 2. User role
    if (msg.role === "user") {
      const parts: AnthropicContentPart[] = [];
      if (typeof msg.content === "string") {
        if (msg.content) parts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        parts.push(...msg.content.map(contentPartToAnthropic));
      }

      if (msg.annotations?.cacheBreakpoint && parts.length > 0) {
        parts[parts.length - 1].cache_control = { type: "ephemeral" };
      }

      rawMessages.push({ role: "user", content: parts });
      continue;
    }

    // 3. Assistant role
    if (msg.role === "assistant") {
      const parts: AnthropicContentPart[] = [];

      // Echo the thinking block with its signature if present (LM6/LM7). D6/MD4: the thinking
      // block's `thinking` field is the reasoning text (msg.reasoning), never the visible
      // answer (msg.content) — those are two distinct wire parts and both must ship: a thinking
      // block requires a signature to be valid, so this only fires when both are present.
      if (msg.annotations?.reasoningSignature && msg.reasoning) {
        parts.push({
          type: "thinking",
          thinking: msg.reasoning,
          signature: msg.annotations.reasoningSignature,
        });
      }
      if (typeof msg.content === "string" && msg.content) {
        parts.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        parts.push(...msg.content.map(contentPartToAnthropic));
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          parts.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: (typeof tc.input === "object" && tc.input !== null ? tc.input : {}) as Record<string, unknown>,
          });
        }
      }

      if (msg.annotations?.cacheBreakpoint && parts.length > 0) {
        parts[parts.length - 1].cache_control = { type: "ephemeral" };
      }

      rawMessages.push({ role: "assistant", content: parts });
      continue;
    }

    // 4. Tool role: mapped to a user message with tool_result content in Anthropic
    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const part: AnthropicContentPart = {
        type: "tool_result",
        tool_use_id: msg.toolCallId ?? "",
        content,
      };

      if (msg.annotations?.cacheBreakpoint) {
        part.cache_control = { type: "ephemeral" };
      }

      rawMessages.push({ role: "user", content: [part] });
    }
  }

  // Anthropic requires strictly alternating user and assistant roles.
  // Merge consecutive messages having the same role.
  const mergedMessages: AnthropicMessage[] = [];
  for (const m of rawMessages) {
    const last = mergedMessages[mergedMessages.length - 1];
    if (last && last.role === m.role) {
      last.content.push(...m.content);
    } else {
      mergedMessages.push({ role: m.role, content: [...m.content] });
    }
  }

  // Ensure conversation begins with a user message if any messages exist
  if (mergedMessages.length > 0 && mergedMessages[0].role === "assistant") {
    mergedMessages.unshift({ role: "user", content: [{ type: "text", text: "Begin." }] });
  }

  const body: AnthropicRequestBody = {
    model: req.model,
    messages: mergedMessages,
    max_tokens: req.maxOutputTokens ?? 4096,
    stream: true,
  };

  if (systemParts.length > 0) {
    body.system = systemParts;
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(encodeTool);
  }
  if (req.temperature != null) {
    body.temperature = req.temperature;
  }

  const breakpoints = countCacheBreakpoints(body);
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `Anthropic request would set ${breakpoints} cache_control breakpoints; the API accepts at most ${MAX_CACHE_BREAKPOINTS}. docs/LOOP_MENDING_PLAN.md G2 — Rama's layout (3 buildPrompt system blocks + 1 conversation tail) is already at the limit, so this means a block was added without removing one.`,
    );
  }

  return body;
}
