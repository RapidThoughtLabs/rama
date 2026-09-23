// engine/src/llm/openai/decode.ts
//
// Pure: raw OpenAI SSE data string → LlmEvent[]
// Stateful accumulator class for tool-call argument streaming.
// No I/O, no fetch — every vendor quirk is a table-driven fixture test against this.
// docs/LOOP_MIGRATION_PLAN.md §4.6

import type { LlmEvent, LlmUsage, WireFinishReason } from "../types";

// ---------------------------------------------------------------------------
// Tool-call accumulator (stateful — one instance per HTTP request)
// ---------------------------------------------------------------------------

interface AccumulatedCall {
  /** Empty string until the first delta carrying an id arrives (Ollama quirk). */
  id: string;
  /** Empty string until the first delta carrying function.name arrives. */
  name: string;
  /** Raw JSON arguments string — concatenated across deltas, parsed once at flush. */
  arguments: string;
  /** Position in the stream; used to synthesise an id when the provider omits one. */
  index: number;
}

/**
 * Accumulates fragmented tool-call deltas across SSE frames and flushes them as
 * complete tool_call events on finish_reason.
 *
 * docs/LOOP_MIGRATION_PLAN.md §4.6:
 *   "Tool calls are keyed by delta.tool_calls[].index; id and function.name are
 *    taken from whichever fragment first carries them; function.arguments is
 *    concatenated as an opaque string and JSON.parse'd once at finish."
 */
export class ToolCallAccumulator {
  private calls = new Map<number, AccumulatedCall>();
  public currentBlockIndex = 0;
  public lastChannel: "none" | "reasoning" | "text" | "tool" = "none";

  absorb(toolCallDeltas: RawToolCallDelta[]): void {
    for (const delta of toolCallDeltas) {
      const index = delta.index ?? 0;
      let entry = this.calls.get(index);
      if (!entry) {
        entry = { id: "", name: "", arguments: "", index };
        this.calls.set(index, entry);
      }
      if (delta.id && !entry.id) entry.id = delta.id;
      if (delta.function?.name && !entry.name) entry.name = delta.function.name;
      if (delta.function?.arguments) entry.arguments += delta.function.arguments;
    }
  }

  /**
   * Flush all accumulated calls as tool_call events. A parse failure yields
   * input: {} — the tool's own zod schema validation will produce the error
   * the model reads. Never throws.
   * docs/LOOP_MIGRATION_PLAN.md §4.6
   */
  flush(): LlmEvent[] {
    const events: LlmEvent[] = [];
    // Sort by index for deterministic ordering
    const sorted = Array.from(this.calls.values()).sort((a, b) => a.index - b.index);
    for (const call of sorted) {
      let input: unknown = {};
      try {
        if (call.arguments) input = JSON.parse(call.arguments);
      } catch {
        // Malformed JSON from the model — emit with empty input
        input = {};
      }
      // Synthesise a call id when the provider omitted it (Ollama quirk)
      const id = call.id || `call_${call.index}`;
      events.push({ type: "tool_call", id, name: call.name, input, blockIndex: this.currentBlockIndex });
    }
    this.calls.clear();
    return events;
  }

  get size(): number {
    return this.calls.size;
  }
}

// ---------------------------------------------------------------------------
// Raw shapes from the OpenAI SSE wire
// ---------------------------------------------------------------------------

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawDelta {
  role?: string;
  content?: string | null;
  /** Together, OpenAI native thinking models */
  reasoning_content?: string | null;
  /** OpenRouter's reasoning field name */
  reasoning?: string | null;
  tool_calls?: RawToolCallDelta[];
}

interface RawChoice {
  index?: number;
  delta?: RawDelta;
  finish_reason?: string | null;
}

interface RawUsageDetail {
  cached_tokens?: number;
}

interface RawUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: RawUsageDetail;
}

interface RawChunk {
  id?: string;
  choices?: RawChoice[];
  usage?: RawUsage | null;
}

// ---------------------------------------------------------------------------
// Finish reason mapping
// ---------------------------------------------------------------------------

function mapFinishReason(raw: string | null | undefined): WireFinishReason {
  switch (raw) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call": // legacy OpenAI
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
      return "content_filter";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Usage mapping  docs/LOOP_MIGRATION_PLAN.md §4.4
// ---------------------------------------------------------------------------

function decodeUsage(raw: RawUsage): LlmUsage {
  const inputTokens = raw.prompt_tokens ?? 0;
  const outputTokens = raw.completion_tokens ?? 0;
  const cacheReadTokens = raw.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    // CB1 — OpenAI's prompt_tokens is already cache-inclusive, so it doubles directly as the
    // occupancy number (the same one Anthropic's promptTokens computes by adding cache back in).
    promptTokens: inputTokens,
    cacheReadTokens,
    cacheWriteTokens: 0,
    noCacheTokens: inputTokens - cacheReadTokens,
  };
}

// ---------------------------------------------------------------------------
// Frame decoder
// ---------------------------------------------------------------------------

/**
 * Decode one SSE data payload string into zero or more LlmEvents.
 *
 * The accumulator is mutated in place (tool call fragments are absorbed);
 * tool_call events are only emitted on finish_reason (when the accumulator is flushed).
 *
 * @param data  Raw string after `data: ` — must NOT be `[DONE]`.
 * @param acc   Mutable accumulator; create one per HTTP request.
 */
export function decodeFrame(data: string, acc: ToolCallAccumulator): LlmEvent[] {
  let chunk: RawChunk;
  try {
    chunk = JSON.parse(data) as RawChunk;
  } catch {
    // Malformed SSE frame — skip silently (keepalive variants, vendor noise)
    return [];
  }

  const events: LlmEvent[] = [];

  // A chunk can have an empty choices array (usage-only chunk) or multiple choices
  // (unusual but tolerated). Together sends duplicate/empty final chunks — tolerate
  // choices:[] on any chunk, not just the usage one.
  // docs/LOOP_MIGRATION_PLAN.md §4.6
  for (const choice of chunk.choices ?? []) {
    const delta = choice.delta;
    if (!delta) continue;

    // Reasoning / thinking delta (LM6)
    // Accept both field names: reasoning_content (Together/OpenAI) and reasoning (OpenRouter)
    // docs/LOOP_MIGRATION_PLAN.md §4.6
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (reasoning) {
      if (acc.lastChannel !== "reasoning" && acc.lastChannel !== "none") {
        acc.currentBlockIndex++;
      }
      acc.lastChannel = "reasoning";
      events.push({ type: "reasoning.delta", text: reasoning, blockIndex: acc.currentBlockIndex });
    }

    // Text delta
    if (delta.content) {
      if (acc.lastChannel !== "text" && acc.lastChannel !== "none") {
        acc.currentBlockIndex++;
      }
      acc.lastChannel = "text";
      events.push({ type: "text.delta", text: delta.content, blockIndex: acc.currentBlockIndex });
    }

    // Tool call fragments — absorbed into the accumulator
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      if (acc.lastChannel !== "tool" && acc.lastChannel !== "none") {
        acc.currentBlockIndex++;
      }
      acc.lastChannel = "tool";
      acc.absorb(delta.tool_calls);
    }

    // Finish reason — flush accumulated tool calls first, then emit finish
    if (choice.finish_reason) {
      events.push(...acc.flush());
      events.push({ type: "finish", reason: mapFinishReason(choice.finish_reason) });
    }
  }

  // Usage chunk (choices may be empty)
  // docs/LOOP_MIGRATION_PLAN.md §4.4
  if (chunk.usage) {
    events.push({ type: "usage", usage: decodeUsage(chunk.usage) });
  }

  return events;
}
