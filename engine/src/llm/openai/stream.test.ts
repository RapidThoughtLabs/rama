// engine/src/llm/openai/stream.test.ts
//
// docs/LOOP_MENDING_PLAN.md MD1/D5/D7 — a stream that ends (EOF or [DONE]) without ever sending
// a finish_reason must not silently drop buffered tool calls, and executeStep must never see a
// step that ended with neither a tool call nor a finish event.

import { afterEach, describe, expect, test } from "bun:test";
import { OpenAIStreamClient } from "./stream";
import { LlmError } from "../types";
import type { LlmEvent } from "../types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function mockFetchReturning(response: Response) {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function client(): OpenAIStreamClient {
  return new OpenAIStreamClient({ baseUrl: "http://localhost:11434/v1" });
}

function errorResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function drain(events: AsyncIterable<LlmEvent>): Promise<never> {
  for await (const _ of events) {
    // drain until it throws
  }
  throw new Error("expected stream() to throw, but it completed without error");
}

describe("OpenAIStreamClient — D5: flush at EOF with no finish_reason", () => {
  test("tool-call fragments with no finish_reason are still flushed, and a finish event is synthesised", async () => {
    mockFetchReturning(
      sseResponse([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"path\\":\\"a.ts\\"}"}}]}}]}\n\n',
        // Stream just ends here — no finish_reason chunk, no [DONE].
      ])
    );

    const events = await collect(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));

    const toolCall = events.find((e) => e.type === "tool_call");
    expect(toolCall).toEqual({ type: "tool_call", id: "call_1", name: "read", input: { path: "a.ts" }, blockIndex: 0 });
    const finish = events.find((e) => e.type === "finish");
    expect(finish).toEqual({ type: "finish", reason: "tool_calls" });
  });

  test("a plain text stream that ends without finish_reason synthesises reason: stop, not silence", async () => {
    mockFetchReturning(sseResponse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n']));

    const events = await collect(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));

    expect(events.filter((e) => e.type === "text.delta")).toEqual([{ type: "text.delta", text: "hi", blockIndex: 0 }]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
  });

  test("a normal stream that does send finish_reason is not double-finished", async () => {
    mockFetchReturning(
      sseResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );

    const events = await collect(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
    expect(events.filter((e) => e.type === "finish")).toHaveLength(1);
  });
});

// docs/LOOP_MENDING_PLAN.md MD6 — the only thing that ever exercised classifyHttpError was the
// now-deleted scratch-verify.ts, and only against a live provider a human had to read the output
// of. These fixtures are what let that script go: overflow must be classified before the durable
// check (§4.5), or a too-long conversation gets the model wrongly marked broken.
describe("OpenAIStreamClient — HTTP error classification", () => {
  test("400 context_length_exceeded is classified overflow, not durable", async () => {
    mockFetchReturning(errorResponse(400, { error: { message: "too long", code: "context_length_exceeded" } }));
    try {
      await drain(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
      throw new Error("unreachable");
    } catch (err) {
      expect(LlmError.isInstance(err)).toBe(true);
      expect((err as LlmError).kind).toBe("overflow");
    }
  });

  test("400 with an overflow-shaped message but no code is still classified overflow", async () => {
    mockFetchReturning(
      errorResponse(400, { error: { message: "This model's maximum context length is 8192 tokens." } })
    );
    try {
      await drain(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
      throw new Error("unreachable");
    } catch (err) {
      expect(LlmError.isInstance(err)).toBe(true);
      expect((err as LlmError).kind).toBe("overflow");
    }
  });

  test("400 with an unrelated message is classified durable, not overflow", async () => {
    mockFetchReturning(errorResponse(400, { error: { message: "invalid request: bad parameter" } }));
    try {
      await drain(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
      throw new Error("unreachable");
    } catch (err) {
      expect(LlmError.isInstance(err)).toBe(true);
      expect((err as LlmError).kind).toBe("durable");
    }
  });

  test("401/403/404 are classified durable", async () => {
    for (const status of [401, 403, 404]) {
      mockFetchReturning(errorResponse(status, { error: { message: "nope" } }));
      try {
        await drain(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
        throw new Error("unreachable");
      } catch (err) {
        expect(LlmError.isInstance(err)).toBe(true);
        expect((err as LlmError).kind).toBe("durable");
      }
    }
  });

  test("429/500 are classified transient", async () => {
    for (const status of [429, 500]) {
      mockFetchReturning(errorResponse(status, { error: { message: "server hiccup" } }));
      try {
        await drain(client().stream({ model: "m", messages: [], signal: new AbortController().signal }));
        throw new Error("unreachable");
      } catch (err) {
        expect(LlmError.isInstance(err)).toBe(true);
        expect((err as LlmError).kind).toBe("transient");
      }
    }
  });
});
