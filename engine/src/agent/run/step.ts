// engine/src/agent/run/step.ts
//
// Single step execution: project -> stream -> accumulate -> execute tools.
// docs/LOOP_MIGRATION_PLAN.md §6.3

import { createToolCall, finalizeToolCall } from "../../db/toolCalls";
import type { LlmClient, LlmUsage, WireFinishReason, WireTool } from "../../llm/types";
import type { RamaToolSet } from "../../tools/define";
import type { ToolCtx, ToolResult } from "../../tools/types";
import { broadcast } from "../../ws";
import { project, type ProjectionPolicy, type Transcript } from "./transcript";

// ---------------------------------------------------------------------------
// Concurrency policy allowlist
// docs/LOOP_MIGRATION_PLAN.md §6.3:
// Only pure filesystem/git reads run with Promise.all.
// check, explore, review, and test are explicitly excluded.
// ---------------------------------------------------------------------------
export const PARALLEL_TOOL_ALLOWLIST = new Set([
  "read",
  "glob",
  "grep",
  "tree",
  "outline",
  "git",
]);

export interface StepContext {
  chatId: string;
  runId: string;
  assistantMessageId: string;
  client: LlmClient;
  model: string;
  transcript: Transcript;
  policy: ProjectionPolicy;
  tools: RamaToolSet;
  toolCtx: ToolCtx;
  unverifiedWrites: Set<string>;
  signal: AbortSignal;
}

export interface StepResult {
  text: string;
  reasoning?: string;
  /** Anthropic's opaque thinking-block signature (D6/MD4) — undefined for every other provider. */
  reasoningSignature?: string;
  finishReason: WireFinishReason;
  toolCalls: { id: string; name: string; input: unknown }[];
  usage: LlmUsage;
  blockedOnQuestion: boolean;
}

interface QueuedToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * Execute a single tool call, recording its result in the DB and broadcast stream.
 */
async function executeSingleTool(
  call: QueuedToolCall,
  ctx: StepContext,
  toolOutputRef: { output?: ToolResult }
): Promise<ToolResult> {
  const tool = ctx.tools[call.name];
  let output: ToolResult;

  if (!tool) {
    output = {
      ok: false,
      summary: `unknown tool: ${call.name}`,
      content: `No tool named "${call.name}".`,
    };
  } else {
    try {
      const raw = await tool.execute(call.input, { toolCallId: call.id });
      if (raw && typeof raw === "object" && "ok" in raw && "summary" in raw) {
        output = raw as ToolResult;
      } else {
        output = { ok: true, summary: "ok", content: String(raw) };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      output = { ok: false, summary: "tool failed", content: `error: ${message}` };
    }
  }

  toolOutputRef.output = output;

  // Feeds read tracker
  if (output.meta?.filesRead?.length) {
    ctx.toolCtx.reads.record(output.meta.filesRead);
  }

  // Completion gate tracking: check clears, write adds
  if (call.name === "check") {
    ctx.unverifiedWrites.clear();
  } else if (output.ok && output.meta?.filesWritten?.length) {
    for (const f of output.meta.filesWritten) {
      ctx.unverifiedWrites.add(f);
    }
  }

  finalizeToolCall(call.id, {
    ok: output.ok,
    resultSummary: output.summary,
    resultContent: output.content ?? null,
    resultMeta: (output.meta as Record<string, unknown> | undefined) ?? null,
    endedAt: Date.now(),
  });

  broadcast(ctx.chatId, {
    type: "tool.result",
    callId: call.id,
    ok: output.ok,
    summary: output.summary,
    artifactId: output.artifactId,
  });

  return output;
}

/**
 * Run a single step: project transcript -> stream request -> accumulate -> execute tools.
 */
export async function executeStep(ctx: StepContext): Promise<StepResult> {
  const wireMessages = project(ctx.transcript, ctx.policy);

  const wireTools: WireTool[] = Object.entries(ctx.tools).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema: def.inputSchema,
  }));

  let stepText = "";
  let stepReasoning = "";
  let stepReasoningSignature: string | undefined;
  let thinkingStartTime: number | null = null;
  let thinkingDone = false;
  let finishReason: WireFinishReason = "unknown";
  let sawFirstChunk = false;
  let blockedOnQuestion = false;
  const queuedCalls: QueuedToolCall[] = [];

  const maybeFinishThinking = () => {
    if (thinkingStartTime !== null && !thinkingDone) {
      thinkingDone = true;
      const durationMs = Date.now() - thinkingStartTime;
      broadcast(ctx.chatId, { type: "thinking.done", runId: ctx.runId, durationMs });
    }
  };

  let stepUsage: LlmUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    noCacheTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  for await (const event of ctx.client.stream({
    model: ctx.model,
    messages: wireMessages,
    tools: wireTools.length > 0 ? wireTools : undefined,
    signal: ctx.signal,
  })) {
    switch (event.type) {
      case "text.delta": {
        maybeFinishThinking();
        if (!sawFirstChunk) {
          sawFirstChunk = true;
          broadcast(ctx.chatId, { type: "status", state: "streaming", verb: "responding" });
        }
        stepText += event.text;
        broadcast(ctx.chatId, { type: "message.delta", runId: ctx.runId, text: event.text });
        break;
      }
      case "reasoning.delta": {
        if (thinkingStartTime === null) {
          thinkingStartTime = Date.now();
        }
        stepReasoning += event.text;
        broadcast(ctx.chatId, { type: "thinking.delta", runId: ctx.runId, text: event.text });
        break;
      }
      case "reasoning.done": {
        stepReasoningSignature = event.signature;
        break;
      }
      case "tool_call": {
        maybeFinishThinking();
        if (event.name === "clarify") {
          blockedOnQuestion = true;
        }
        createToolCall({
          id: event.id,
          messageId: ctx.assistantMessageId,
          chatId: ctx.chatId,
          name: event.name,
          input: event.input,
          startedAt: Date.now(),
        });
        broadcast(ctx.chatId, {
          type: "tool.call",
          callId: event.id,
          name: event.name,
          input: event.input,
          ts: Date.now(),
        });
        broadcast(ctx.chatId, { type: "status", state: "tool", verb: `running ${event.name}` });
        queuedCalls.push({ id: event.id, name: event.name, input: event.input });
        break;
      }
      case "usage": {
        stepUsage = event.usage;
        break;
      }
      case "finish": {
        finishReason = event.reason;
        break;
      }
    }
  }

  maybeFinishThinking();

  // Append assistant turn to transcript
  ctx.transcript.entries.push({
    kind: "assistant",
    id: ctx.assistantMessageId,
    text: stepText,
    reasoning: stepReasoning || undefined,
    reasoningSignature: stepReasoningSignature,
    calls: queuedCalls.map((c) => ({ id: c.id, name: c.name, input: c.input })),
  });

  // Execute queued tool calls
  if (queuedCalls.length > 0) {
    const isAllParallel =
      queuedCalls.length > 1 && queuedCalls.every((c) => PARALLEL_TOOL_ALLOWLIST.has(c.name));

    if (isAllParallel) {
      // Parallel execution for pure read batches (read, glob, grep, tree, outline, git)
      const outputRefs: { output?: ToolResult }[] = queuedCalls.map(() => ({}));
      await Promise.all(
        queuedCalls.map((call, idx) => executeSingleTool(call, ctx, outputRefs[idx]))
      );
      for (let i = 0; i < queuedCalls.length; i++) {
        const call = queuedCalls[i];
        const out = outputRefs[i].output;
        ctx.transcript.entries.push({
          kind: "tool",
          callId: call.id,
          name: call.name,
          ok: out?.ok ?? false,
          content: out?.content ?? out?.summary ?? "",
        });
      }
    } else {
      // Sequential execution for anything involving mutations or complex tools
      for (const call of queuedCalls) {
        const outputRef: { output?: ToolResult } = {};
        await executeSingleTool(call, ctx, outputRef);
        const out = outputRef.output;
        ctx.transcript.entries.push({
          kind: "tool",
          callId: call.id,
          name: call.name,
          ok: out?.ok ?? false,
          content: out?.content ?? out?.summary ?? "",
        });
      }
    }

    broadcast(ctx.chatId, { type: "status", state: "thinking", verb: "thinking" });
  }

  return {
    text: stepText,
    reasoning: stepReasoning || undefined,
    reasoningSignature: stepReasoningSignature,
    finishReason,
    toolCalls: queuedCalls,
    usage: stepUsage,
    blockedOnQuestion,
  };
}
