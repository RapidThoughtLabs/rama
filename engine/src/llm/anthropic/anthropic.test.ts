// engine/src/llm/anthropic/anthropic.test.ts
//
// Tests for Phase LM7: Anthropic Transport (encode, decode, client resolution)
// docs/LOOP_MIGRATION_PLAN.md LM7

import { describe, expect, test } from "bun:test";
import type { ProviderRow } from "../../db/providers";
import { resolveClient } from "../client";
import type { LlmRequest, WireMessage, WireTool } from "../types";
import { AnthropicAccumulator, decodeFrame } from "./decode";
import { encodeRequest } from "./encode";
import { AnthropicStreamClient } from "./stream";

describe("Anthropic Transport (LM7)", () => {
  describe("encodeRequest", () => {
    test("renders system prompt and extracts cacheBreakpoint", () => {
      const messages: WireMessage[] = [
        {
          role: "system",
          content: "You are a helpful assistant.",
          annotations: { cacheBreakpoint: true },
        },
        {
          role: "user",
          content: "Hello",
          annotations: { cacheBreakpoint: true },
        },
      ];

      const req: LlmRequest = {
        model: "claude-3-5-sonnet-20241022",
        messages,
        signal: new AbortController().signal,
      };

      const body = encodeRequest(req);
      expect(body.model).toBe("claude-3-5-sonnet-20241022");
      expect(body.system).toBeDefined();
      expect(body.system![0]).toEqual({
        type: "text",
        text: "You are a helpful assistant.",
        cache_control: { type: "ephemeral" },
      });

      // User message last content part has cache_control
      expect(body.messages.length).toBe(1);
      expect(body.messages[0].role).toBe("user");
      expect(body.messages[0].content[0]).toEqual({
        type: "text",
        text: "Hello",
        cache_control: { type: "ephemeral" },
      });
    });

    test("renders assistant tool calls and converts tool results to user tool_result blocks", () => {
      const messages: WireMessage[] = [
        { role: "user", content: "Check git status" },
        {
          role: "assistant",
          content: "Running git...",
          toolCalls: [{ id: "call_git_1", name: "git", input: { command: "status" } }],
        },
        {
          role: "tool",
          toolCallId: "call_git_1",
          content: "On branch main",
          annotations: { cacheBreakpoint: true },
        },
      ];

      const tools: WireTool[] = [
        {
          name: "git",
          description: "Run git command",
          inputSchema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ];

      const req: LlmRequest = {
        model: "claude-3-5-sonnet-20241022",
        messages,
        tools,
        signal: new AbortController().signal,
      };

      const body = encodeRequest(req);
      expect(body.tools).toBeDefined();
      expect(body.tools![0].name).toBe("git");
      expect(body.tools![0].input_schema).toEqual(tools[0].inputSchema);

      // 3 messages: user, assistant, user (tool result)
      expect(body.messages.length).toBe(3);

      // Assistant message has text + tool_use
      expect(body.messages[1].role).toBe("assistant");
      expect(body.messages[1].content).toEqual([
        { type: "text", text: "Running git..." },
        { type: "tool_use", id: "call_git_1", name: "git", input: { command: "status" } },
      ]);

      // Tool result is mapped to user role with tool_result block + cache_control
      expect(body.messages[2].role).toBe("user");
      expect(body.messages[2].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call_git_1",
        content: "On branch main",
        cache_control: { type: "ephemeral" },
      });
    });

    test("merges consecutive messages of same role to maintain alternating roles", () => {
      const messages: WireMessage[] = [
        { role: "user", content: "Do step 1" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call_1", name: "read", input: { path: "a.ts" } },
            { id: "call_2", name: "read", input: { path: "b.ts" } },
          ],
        },
        // Two consecutive tool messages
        { role: "tool", toolCallId: "call_1", content: "content a" },
        { role: "tool", toolCallId: "call_2", content: "content b" },
      ];

      const req: LlmRequest = {
        model: "claude-3-5-sonnet-20241022",
        messages,
        signal: new AbortController().signal,
      };

      const body = encodeRequest(req);
      // Merged into: user, assistant, user (with two tool_result blocks)
      expect(body.messages.length).toBe(3);
      expect(body.messages[2].role).toBe("user");
      expect(body.messages[2].content.length).toBe(2);
      expect(body.messages[2].content[0]).toEqual({
        type: "tool_result",
        tool_use_id: "call_1",
        content: "content a",
      });
      expect(body.messages[2].content[1]).toEqual({
        type: "tool_result",
        tool_use_id: "call_2",
        content: "content b",
      });
    });

    test("renders thinking block with reasoningSignature when present, alongside the visible text", () => {
      const messages: WireMessage[] = [
        { role: "user", content: "Ponder this problem" },
        {
          role: "assistant",
          content: "Based on that, here's the answer.",
          reasoning: "Let me think deeply...",
          annotations: { reasoningSignature: "sig_abc123" },
        },
      ];

      const req: LlmRequest = {
        model: "claude-3-7-sonnet-20250219",
        messages,
        signal: new AbortController().signal,
      };

      const body = encodeRequest(req);
      expect(body.messages[1].content[0]).toEqual({
        type: "thinking",
        thinking: "Let me think deeply...",
        signature: "sig_abc123",
      });
      expect(body.messages[1].content[1]).toEqual({
        type: "text",
        text: "Based on that, here's the answer.",
      });
    });

    test("omits the thinking block when a signature is present but reasoning text is not (D6)", () => {
      const messages: WireMessage[] = [
        { role: "user", content: "Ponder this problem" },
        {
          role: "assistant",
          content: "Just the answer.",
          annotations: { reasoningSignature: "sig_abc123" },
        },
      ];

      const req: LlmRequest = {
        model: "claude-3-7-sonnet-20250219",
        messages,
        signal: new AbortController().signal,
      };

      const body = encodeRequest(req);
      expect(body.messages[1].content).toEqual([{ type: "text", text: "Just the answer." }]);
    });
  });

  describe("cache breakpoint guard (G2)", () => {
    test("Rama's real layout — 3 cached system blocks + 1 cached conversation tail — encodes at exactly the limit without throwing", () => {
      const messages: WireMessage[] = [
        { role: "system", content: "kernel+tools", annotations: { cacheBreakpoint: true } },
        { role: "system", content: "agent+mode", annotations: { cacheBreakpoint: true } },
        { role: "system", content: "project+env", annotations: { cacheBreakpoint: true } },
        { role: "user", content: "hello", annotations: { cacheBreakpoint: true } },
      ];
      const req: LlmRequest = { model: "claude-3-7-sonnet-20250219", messages, signal: new AbortController().signal };
      expect(() => encodeRequest(req)).not.toThrow();
      const body = encodeRequest(req);
      expect(body.system).toHaveLength(3);
      expect(body.system!.every((p) => p.cache_control)).toBe(true);
      expect(body.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
    });

    test("a fifth cache_control marker throws rather than silently exceeding Anthropic's max of 4", () => {
      const messages: WireMessage[] = [
        { role: "system", content: "kernel+tools", annotations: { cacheBreakpoint: true } },
        { role: "system", content: "agent+mode", annotations: { cacheBreakpoint: true } },
        { role: "system", content: "project+env", annotations: { cacheBreakpoint: true } },
        { role: "system", content: "one block too many", annotations: { cacheBreakpoint: true } },
        { role: "user", content: "hello", annotations: { cacheBreakpoint: true } },
      ];
      const req: LlmRequest = { model: "claude-3-7-sonnet-20250219", messages, signal: new AbortController().signal };
      expect(() => encodeRequest(req)).toThrow(/cache_control breakpoints/);
    });
  });

  describe("decodeFrame", () => {
    test("decodes full streaming lifecycle: start, text, tool_use, finish, usage", () => {
      const acc = new AnthropicAccumulator();

      // 1. message_start with cache details
      const startEvents = decodeFrame(
        JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_1",
            role: "assistant",
            usage: {
              input_tokens: 1000,
              cache_read_input_tokens: 750,
              cache_creation_input_tokens: 150,
              output_tokens: 0,
            },
          },
        }),
        acc
      );
      expect(startEvents.length).toBe(0);
      expect(acc.usage.inputTokens).toBe(1000);
      expect(acc.usage.cacheReadTokens).toBe(750);
      expect(acc.usage.cacheWriteTokens).toBe(150);
      expect(acc.usage.noCacheTokens).toBe(250);

      // 2. text content block delta
      const textEvents = decodeFrame(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Here is the result." },
        }),
        acc
      );
      expect(textEvents).toEqual([{ type: "text.delta", text: "Here is the result." }]);

      // 3. tool_use block start
      decodeFrame(
        JSON.stringify({
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_123", name: "read", input: {} },
        }),
        acc
      );

      // 4. input_json_delta fragments
      decodeFrame(
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '{"path": ' },
        }),
        acc
      );
      decodeFrame(
        JSON.stringify({
          type: "content_block_delta",
          index: 1,
          delta: { type: "input_json_delta", partial_json: '"src/index.ts"}' },
        }),
        acc
      );

      // 5. content_block_stop emits complete tool_call
      const toolStopEvents = decodeFrame(
        JSON.stringify({
          type: "content_block_stop",
          index: 1,
        }),
        acc
      );
      expect(toolStopEvents).toEqual([
        {
          type: "tool_call",
          id: "toolu_123",
          name: "read",
          input: { path: "src/index.ts" },
        },
      ]);

      // 6. message_delta sets stop_reason and output tokens
      decodeFrame(
        JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 45 },
        }),
        acc
      );

      // 7. message_stop emits usage and finish
      const stopEvents = decodeFrame(
        JSON.stringify({
          type: "message_stop",
        }),
        acc
      );

      expect(stopEvents).toEqual([
        {
          type: "usage",
          usage: {
            inputTokens: 1000,
            outputTokens: 45,
            totalTokens: 1045,
            noCacheTokens: 250,
            cacheReadTokens: 750,
            cacheWriteTokens: 150,
          },
        },
        {
          type: "finish",
          reason: "tool_calls",
        },
      ]);
    });

    test("decodes thinking_delta and captures signature_delta", () => {
      const acc = new AnthropicAccumulator();

      const events1 = decodeFrame(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Thinking through the logic..." },
        }),
        acc
      );
      expect(events1).toEqual([{ type: "reasoning.delta", text: "Thinking through the logic..." }]);

      decodeFrame(
        JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig_789" },
        }),
        acc
      );
      expect(acc.reasoningSignature).toBe("sig_789");
    });
  });

  describe("resolveClient", () => {
    test("resolves an Anthropic provider into AnthropicStreamClient without throwing", () => {
      const providerRow: ProviderRow = {
        id: "anthropic",
        kind: "anthropic",
        base_url: "https://api.anthropic.com",
        label: "Anthropic",
        created_at: 0,
        models_hash: null,
        models_fetched_at: null,
        last_health_status: null,
        last_health_at: null,
        is_custom: 0,
        enabled: 1,
        requires_key: 1,
        auth_style: "bearer",
        auth_header: null,
        extra_headers_json: "{}",
      };

      const client = resolveClient(providerRow, "claude-3-5-sonnet-20241022", "sk-ant-123");
      expect(client).toBeInstanceOf(AnthropicStreamClient);
    });
  });
});
