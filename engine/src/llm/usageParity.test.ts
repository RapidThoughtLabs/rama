// engine/src/llm/usageParity.test.ts
//
// CONTEXT_BUDGET_PLAN.md CB1 acceptance: a per-provider fixture test asserting that the same
// logical request — same total prompt size, same cache-read fraction — yields the same
// promptTokens under both adapters. This is the guard CB1's risk register item 5 asks for: a
// third provider getting usage semantics wrong again should fail this test, not ship silently.

import { describe, expect, test } from "bun:test";
import { AnthropicAccumulator, decodeFrame as decodeAnthropicFrame } from "./anthropic/decode";
import { ToolCallAccumulator, decodeFrame as decodeOpenAIFrame } from "./openai/decode";

describe("CB1: promptTokens has one meaning across providers", () => {
  test("same logical request (1000 prompt tokens, 700 cache-read) yields the same promptTokens", () => {
    // Anthropic: input_tokens is net of cache by construction, so the wire sends the split
    // directly — 300 uncached + 700 cache-read = 1000 total prompt tokens.
    const anthropicAcc = new AnthropicAccumulator();
    decodeAnthropicFrame(
      JSON.stringify({
        type: "message_start",
        message: {
          usage: { input_tokens: 300, cache_read_input_tokens: 700, cache_creation_input_tokens: 0, output_tokens: 0 },
        },
      }),
      anthropicAcc
    );

    // OpenAI: prompt_tokens is already cache-inclusive — the wire sends the total directly, with
    // the cached portion broken out separately.
    const openaiAcc = new ToolCallAccumulator();
    const openaiEvents = decodeOpenAIFrame(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 700 } } }),
      openaiAcc
    );
    const openaiUsage = openaiEvents.find((e) => e.type === "usage");

    expect(anthropicAcc.usage.promptTokens).toBe(1000);
    expect(openaiUsage?.type).toBe("usage");
    if (openaiUsage?.type === "usage") {
      expect(openaiUsage.usage.promptTokens).toBe(1000);
      expect(openaiUsage.usage.promptTokens).toBe(anthropicAcc.usage.promptTokens);
    }
  });

  test("zero cache activity: promptTokens equals the raw uncached size on both providers", () => {
    const anthropicAcc = new AnthropicAccumulator();
    decodeAnthropicFrame(
      JSON.stringify({
        type: "message_start",
        message: { usage: { input_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 } },
      }),
      anthropicAcc
    );

    const openaiAcc = new ToolCallAccumulator();
    const openaiEvents = decodeOpenAIFrame(
      JSON.stringify({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 0 } }),
      openaiAcc
    );
    const openaiUsage = openaiEvents.find((e) => e.type === "usage");

    expect(anthropicAcc.usage.promptTokens).toBe(500);
    if (openaiUsage?.type === "usage") {
      expect(openaiUsage.usage.promptTokens).toBe(500);
    }
  });
});
