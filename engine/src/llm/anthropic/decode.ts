// engine/src/llm/anthropic/decode.ts
//
// Pure: raw Anthropic SSE data string → LlmEvent[]
// Stateful accumulator class for tool-call argument and usage streaming.
// No I/O, no fetch — every vendor quirk is a table-driven fixture test against this.
// docs/LOOP_MIGRATION_PLAN.md §4.4, §4.6, LM7

import type { LlmEvent, LlmUsage, WireFinishReason } from "../types";

export class AnthropicAccumulator {
  private toolCalls = new Map<number, { id: string; name: string; argumentsJson: string }>();
  public usage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    promptTokens: 0,
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  public finishReason: WireFinishReason = "unknown";
  public reasoningSignature?: string;

  recordToolStart(index: number, id: string, name: string): void {
    this.toolCalls.set(index, { id, name, argumentsJson: "" });
  }

  appendToolJson(index: number, partialJson: string): void {
    const call = this.toolCalls.get(index);
    if (call) {
      call.argumentsJson += partialJson;
    }
  }

  flushTool(index: number): LlmEvent[] {
    const call = this.toolCalls.get(index);
    if (!call) return [];
    this.toolCalls.delete(index);

    let input: unknown = {};
    try {
      if (call.argumentsJson.trim()) {
        input = JSON.parse(call.argumentsJson);
      }
    } catch {
      input = {};
    }

    return [{ type: "tool_call", id: call.id, name: call.name, input, blockIndex: index }];
  }

  flushAllTools(): LlmEvent[] {
    const events: LlmEvent[] = [];
    for (const index of Array.from(this.toolCalls.keys()).sort((a, b) => a - b)) {
      events.push(...this.flushTool(index));
    }
    return events;
  }
}

function mapStopReason(raw: string | null | undefined): WireFinishReason {
  switch (raw) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    default:
      return "unknown";
  }
}

export function decodeFrame(data: string, acc: AnthropicAccumulator): LlmEvent[] {
  let chunk: Record<string, unknown>;
  try {
    chunk = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return [];
  }

  const events: LlmEvent[] = [];
  const type = String(chunk.type ?? "");

  switch (type) {
    case "message_start": {
      const msg = chunk.message as {
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      } | undefined;

      if (msg?.usage) {
        const inputTokens = msg.usage.input_tokens ?? 0;
        const cacheReadTokens = msg.usage.cache_read_input_tokens ?? 0;
        const cacheWriteTokens = msg.usage.cache_creation_input_tokens ?? 0;

        acc.usage.inputTokens = inputTokens;
        acc.usage.cacheReadTokens = cacheReadTokens;
        acc.usage.cacheWriteTokens = cacheWriteTokens;
        // CB1 — Anthropic's input_tokens already excludes cache read/write; subtracting
        // cacheReadTokens again double-subtracted from an already-net field.
        acc.usage.noCacheTokens = inputTokens;
        // CB1 — the full request size, cache-inclusive: the one occupancy number that means
        // the same thing on every provider.
        acc.usage.promptTokens = inputTokens + cacheReadTokens + cacheWriteTokens;
      }
      break;
    }

    case "content_block_start": {
      const index = Number(chunk.index ?? 0);
      const block = chunk.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "tool_use") {
        acc.recordToolStart(index, block.id ?? `toolu_${index}`, block.name ?? "");
      }
      break;
    }

    case "content_block_delta": {
      const index = Number(chunk.index ?? 0);
      const delta = chunk.delta as {
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        partial_json?: string;
      } | undefined;

      if (delta) {
        if (delta.type === "text_delta" && delta.text) {
          events.push({ type: "text.delta", text: delta.text, blockIndex: index });
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          events.push({ type: "reasoning.delta", text: delta.thinking, blockIndex: index });
        } else if (delta.type === "signature_delta" && delta.signature) {
          acc.reasoningSignature = delta.signature;
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          acc.appendToolJson(index, delta.partial_json);
        }
      }
      break;
    }

    case "content_block_stop": {
      const index = Number(chunk.index ?? 0);
      events.push(...acc.flushTool(index));
      break;
    }

    case "message_delta": {
      const delta = chunk.delta as { stop_reason?: string } | undefined;
      const usage = chunk.usage as { output_tokens?: number } | undefined;

      if (delta?.stop_reason) {
        acc.finishReason = mapStopReason(delta.stop_reason);
      }
      if (usage?.output_tokens != null) {
        acc.usage.outputTokens = usage.output_tokens;
      }
      break;
    }

    case "message_stop": {
      // Flush any lingering tool calls
      events.push(...acc.flushAllTools());
      // D6/MD4 — carry the signature across the transport boundary; step.ts records it on the
      // assistant TranscriptEntry so it can round-trip on the next request.
      if (acc.reasoningSignature) {
        events.push({ type: "reasoning.done", signature: acc.reasoningSignature });
      }
      events.push({ type: "usage", usage: { ...acc.usage } });
      events.push({ type: "finish", reason: acc.finishReason });
      break;
    }
  }

  return events;
}
