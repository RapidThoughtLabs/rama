// engine/src/llm/openai/encode.test.ts
//
// docs/LOOP_MENDING_PLAN.md MD1/D4/D7 — strict:true was unconditional and broke OpenAI proper
// (every optional param + the passed-through $schema key). Default it off; strip $schema.

import { describe, expect, test } from "bun:test";
import type { LlmRequest, WireMessage, WireTool } from "../types";
import { encodeRequest } from "./encode";

function req(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hi" }],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("encodeRequest — messages", () => {
  test("plain user message", () => {
    const body = encodeRequest(req());
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  test("assistant message with tool calls encodes function.arguments as a JSON string", () => {
    const messages: WireMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", input: { path: "a.ts" } }],
      },
    ];
    const body = encodeRequest(req({ messages }));
    expect(body.messages[0].tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } },
    ]);
  });

  test("tool result message carries tool_call_id", () => {
    const messages: WireMessage[] = [{ role: "tool", toolCallId: "call_1", content: "file contents" }];
    const body = encodeRequest(req({ messages }));
    expect(body.messages[0]).toEqual({ role: "tool", content: "file contents", tool_call_id: "call_1" });
  });

  test("annotations (cacheBreakpoint, reasoningSignature) are ignored — Anthropic-only", () => {
    const messages: WireMessage[] = [{ role: "user", content: "hi", annotations: { cacheBreakpoint: true } }];
    const body = encodeRequest(req({ messages }));
    expect(body.messages[0]).toEqual({ role: "user", content: "hi" });
  });
});

describe("encodeRequest — tools (D4)", () => {
  function toolWithOptionalFields(): WireTool {
    return {
      name: "read",
      description: "Read a file.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
        required: ["path"],
        additionalProperties: false,
      },
    };
  }

  test("never emits strict — a partially-required schema would violate OpenAI's strict-mode contract", () => {
    const body = encodeRequest(req({ tools: [toolWithOptionalFields()] }));
    expect(body.tools).toHaveLength(1);
    expect(body.tools![0].function).not.toHaveProperty("strict");
  });

  test("strips $schema from the encoded parameters — OpenAI rejects it under strict mode", () => {
    const body = encodeRequest(req({ tools: [toolWithOptionalFields()] }));
    expect(body.tools![0].function.parameters).not.toHaveProperty("$schema");
    expect(body.tools![0].function.parameters.properties).toEqual({
      path: { type: "string" },
      offset: { type: "number" },
      limit: { type: "number" },
    });
  });

  test("a schema with optional fields (required is a strict subset of properties) encodes as-is — this is what OpenAI proper accepts once strict is gone", () => {
    const body = encodeRequest(req({ tools: [toolWithOptionalFields()] }));
    const params = body.tools![0].function.parameters as { required: string[]; properties: Record<string, unknown> };
    expect(params.required).toEqual(["path"]);
    expect(Object.keys(params.properties)).toEqual(["path", "offset", "limit"]);
  });

  test("no tools field when the request has none", () => {
    const body = encodeRequest(req());
    expect(body.tools).toBeUndefined();
  });
});

describe("encodeRequest — generation params", () => {
  test("max_completion_tokens and temperature pass through only when set", () => {
    const body = encodeRequest(req({ maxOutputTokens: 1024, temperature: 0.2 }));
    expect(body.max_completion_tokens).toBe(1024);
    expect(body.temperature).toBe(0.2);

    const bare = encodeRequest(req());
    expect(bare.max_completion_tokens).toBeUndefined();
    expect(bare.temperature).toBeUndefined();
  });
});
