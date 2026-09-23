// engine/src/llm/openai/decode.test.ts
//
// docs/LOOP_MENDING_PLAN.md MD1/D7 — LM0's exit criteria named four fixtures that were never
// written: a fragmented tool call, a whole-call delta with no `id`, an empty-`choices` usage
// chunk, and a keepalive/malformed frame. Plus a fifth here for the accumulator's flush
// behavior and D4's schema stripping (D4 itself lives in encode.test.ts).

import { describe, expect, test } from "bun:test";
import { decodeFrame, ToolCallAccumulator } from "./decode";

function frame(obj: unknown): string {
  return JSON.stringify(obj);
}

describe("decodeFrame — text and reasoning", () => {
  test("emits text.delta for content", () => {
    const acc = new ToolCallAccumulator();
    const events = decodeFrame(frame({ choices: [{ delta: { content: "Hello" } }] }), acc);
    expect(events).toEqual([{ type: "text.delta", text: "Hello", blockIndex: 0 }]);
  });

  test("accepts both reasoning_content (Together/OpenAI) and reasoning (OpenRouter) field names", () => {
    const acc = new ToolCallAccumulator();
    const a = decodeFrame(frame({ choices: [{ delta: { reasoning_content: "thinking..." } }] }), acc);
    expect(a).toEqual([{ type: "reasoning.delta", text: "thinking...", blockIndex: 0 }]);
    const b = decodeFrame(frame({ choices: [{ delta: { reasoning: "pondering..." } }] }), acc);
    expect(b).toEqual([{ type: "reasoning.delta", text: "pondering...", blockIndex: 0 }]);
  });

  test("increments blockIndex when switching between reasoning and text channels", () => {
    const acc = new ToolCallAccumulator();
    const a = decodeFrame(frame({ choices: [{ delta: { reasoning_content: "thinking..." } }] }), acc);
    expect(a).toEqual([{ type: "reasoning.delta", text: "thinking...", blockIndex: 0 }]);
    const b = decodeFrame(frame({ choices: [{ delta: { content: "Hello" } }] }), acc);
    expect(b).toEqual([{ type: "text.delta", text: "Hello", blockIndex: 1 }]);
  });
});

describe("decodeFrame — fragmented tool call (LM0 fixture 1)", () => {
  test("reassembles a tool call fragmented across five frames into one complete tool_call event", () => {
    const acc = new ToolCallAccumulator();
    const frames = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"src/' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'index.ts"' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] }, finish_reason: "tool_calls" }] },
    ];

    let events: ReturnType<typeof decodeFrame> = [];
    for (const f of frames) events = events.concat(decodeFrame(frame(f), acc));

    const toolCallEvents = events.filter((e) => e.type === "tool_call");
    expect(toolCallEvents).toHaveLength(1);
    expect(toolCallEvents[0]).toEqual({
      type: "tool_call",
      id: "call_1",
      name: "read",
      input: { path: "src/index.ts" },
      blockIndex: 0,
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool_calls" });
  });
});

describe("decodeFrame — whole-call delta with no id (LM0 fixture 2, Ollama quirk)", () => {
  test("synthesises call_<index> when the provider never sends an id", () => {
    const acc = new ToolCallAccumulator();
    const events = decodeFrame(
      frame({
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"command":"ls"}' } }] },
            finish_reason: "tool_calls",
          },
        ],
      }),
      acc
    );
    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({ type: "tool_call", id: "call_0", name: "bash", input: { command: "ls" }, blockIndex: 0 });
  });
});

describe("decodeFrame — empty-choices usage chunk (LM0 fixture 3)", () => {
  test("a chunk with choices: [] and a usage object emits only usage, never throws", () => {
    const acc = new ToolCallAccumulator();
    const events = decodeFrame(
      frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }),
      acc
    );
    expect(events).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 20, promptTokens: 100, noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ]);
  });

  test("prompt_tokens_details.cached_tokens splits into noCacheTokens/cacheReadTokens", () => {
    const acc = new ToolCallAccumulator();
    const events = decodeFrame(
      frame({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_tokens_details: { cached_tokens: 60 } },
      }),
      acc
    );
    expect(events).toEqual([
      {
        type: "usage",
        usage: { inputTokens: 100, outputTokens: 20, promptTokens: 100, noCacheTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0 },
      },
    ]);
  });
});

describe("decodeFrame — keepalive / malformed frame (LM0 fixture 4)", () => {
  test("malformed JSON is skipped silently, never throws", () => {
    const acc = new ToolCallAccumulator();
    expect(() => decodeFrame("", acc)).not.toThrow();
    expect(decodeFrame("", acc)).toEqual([]);
    expect(decodeFrame("not json at all", acc)).toEqual([]);
  });

  test("a chunk with no choices and no usage yields no events", () => {
    const acc = new ToolCallAccumulator();
    expect(decodeFrame(frame({ id: "chatcmpl-1" }), acc)).toEqual([]);
  });
});

describe("ToolCallAccumulator.flush (D5 — EOF with no finish_reason)", () => {
  test("flushing mid-accumulation (no finish_reason ever seen) still yields the buffered call", () => {
    const acc = new ToolCallAccumulator();
    decodeFrame(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "grep", arguments: '{"pattern":"foo"}' } }] } }] }), acc);
    // No finish_reason frame arrives — decodeFrame alone never flushes without one.
    expect(acc.size).toBe(1);
    const flushed = acc.flush();
    expect(flushed).toEqual([{ type: "tool_call", id: "call_x", name: "grep", input: { pattern: "foo" }, blockIndex: 0 }]);
    expect(acc.size).toBe(0);
  });

  test("malformed accumulated JSON flushes with empty input rather than throwing", () => {
    const acc = new ToolCallAccumulator();
    decodeFrame(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_y", function: { name: "bash", arguments: "{not valid json" } }] } }] }), acc);
    expect(acc.flush()).toEqual([{ type: "tool_call", id: "call_y", name: "bash", input: {}, blockIndex: 0 }]);
  });
});

describe("mapFinishReason via decodeFrame (D8 — finishReason threading)", () => {
  test("length is preserved distinctly from stop and tool_calls", () => {
    const acc = new ToolCallAccumulator();
    const events = decodeFrame(frame({ choices: [{ delta: {}, finish_reason: "length" }] }), acc);
    expect(events).toEqual([{ type: "finish", reason: "length" }]);
  });
});
