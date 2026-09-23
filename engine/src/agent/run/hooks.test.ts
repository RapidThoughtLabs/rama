// engine/src/agent/run/hooks.test.ts
//
// Tests for Phase LM4 between-step hooks:
// §6.4: The 7 built-in hooks and their priority ordering.

import { describe, expect, test } from "bun:test";
import { STUCK_LOOP_NOTE } from "../loopGuard";
import { BudgetController } from "./budget";
import {
  abortedHook,
  blockedOnQuestionHook,
  budgetHook,
  BUILTIN_HOOKS,
  clearSteeringQueue,
  completionGateHook,
  contextPressureHook,
  dequeueSteeringMessage,
  enqueueSteeringMessage,
  repeatedToolCallHook,
  runStepHooks,
  steeringHook,
  type StepHookContext,
} from "./hooks";
import type { StepResult } from "./step";

function makeContext(overrides: Partial<StepHookContext> = {}): StepHookContext {
  const controller = new AbortController();
  const stepResult: StepResult = {
    text: "Hello",
    finishReason: "stop",
    toolCalls: [],
    usage: {
      inputTokens: 10,
      outputTokens: 10,
      promptTokens: 20,
      noCacheTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    blockedOnQuestion: false,
  };

  return {
    chatId: "chat-test-1",
    runId: "run-test-1",
    signal: controller.signal,
    budget: new BudgetController("agent"),
    stepsHistory: [],
    stepResult,
    unverifiedWrites: new Set(),
    checkAvailable: true,
    usageTotals: {
      inputTokens: 10,
      outputTokens: 10,
      noCacheTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    lastStepInputTokens: stepResult.usage.promptTokens,
    ...overrides,
  };
}

describe("LM4 Between-Step Hooks", () => {
  test("1. abortedHook: stops when aborted", async () => {
    const controller = new AbortController();
    const ctx = makeContext({ signal: controller.signal });
    expect(await abortedHook.after(ctx)).toEqual({ action: "continue" });

    controller.abort();
    expect(await abortedHook.after(ctx)).toEqual({
      action: "stop",
      state: "interrupted-by-user",
    });
  });

  test("2. repeatedToolCallHook: stops on loop detection", async () => {
    const ctx = makeContext({
      stepsHistory: [
        { toolCalls: [{ toolName: "bash", input: "echo hi" }] },
        { toolCalls: [{ toolName: "bash", input: "echo hi" }] },
        { toolCalls: [{ toolName: "bash", input: "echo hi" }] },
      ],
    });
    expect(await repeatedToolCallHook.after(ctx)).toEqual({
      action: "stop",
      state: "stopped-loop-detected",
      note: STUCK_LOOP_NOTE,
    });

    const ctxDifferent = makeContext({
      stepsHistory: [
        { toolCalls: [{ toolName: "bash", input: "echo hi" }] },
        { toolCalls: [{ toolName: "bash", input: "echo bye" }] },
      ],
    });
    expect(await repeatedToolCallHook.after(ctxDifferent)).toEqual({ action: "continue" });
  });

  test("3. budgetHook: stops when budget is exhausted", async () => {
    const budget = new BudgetController("ask"); // maxSteps = 4
    for (let i = 0; i < 4; i++) budget.nextStep();
    expect(budget.isExhausted()).toBe(true);

    const ctx = makeContext({ budget });
    expect(await budgetHook.after(ctx)).toEqual({
      action: "stop",
      state: "stopped-by-budget",
    });
  });

  test("4. steeringHook: injects queued user message", async () => {
    const chatId = "steering-chat-test";
    clearSteeringQueue(chatId);

    const ctx = makeContext({ chatId });
    expect(await steeringHook.after(ctx)).toEqual({ action: "continue" });

    enqueueSteeringMessage(chatId, "Please focus on auth.ts instead");
    const verdict = await steeringHook.after(ctx);
    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.entry.kind).toBe("injected");
      if (verdict.entry.kind === "injected") {
        expect(verdict.entry.role).toBe("user");
        expect(verdict.entry.text).toBe("Please focus on auth.ts instead");
        expect(verdict.entry.ttl).toBe("run");
      }
    }

    // Queue is now empty
    expect(await steeringHook.after(ctx)).toEqual({ action: "continue" });
    clearSteeringQueue(chatId);
  });

  test("5. completionGateHook: nudges when writes are unverified and finishing without tools or text", async () => {
    const ctxNoWrites = makeContext({ unverifiedWrites: new Set() });
    expect(await completionGateHook.after(ctxNoWrites)).toEqual({ action: "continue" });

    const ctxWithWritesNoText = makeContext({
      unverifiedWrites: new Set(["src/auth.ts"]),
      checkAvailable: true,
      stepResult: {
        text: "",
        finishReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, promptTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        blockedOnQuestion: false,
      },
    });
    const verdict = await completionGateHook.after(ctxWithWritesNoText);
    expect(verdict.action).toBe("inject");
    if (verdict.action === "inject") {
      expect(verdict.entry.kind).toBe("injected");
      if (verdict.entry.kind === "injected") {
        expect(verdict.entry.role).toBe("system");
        expect(verdict.entry.text).toContain("Run check now");
        expect(verdict.entry.text).toContain("src/auth.ts");
        expect(verdict.entry.ttl).toBe("step");
      }
    }

    // If prose was already written in this step, completionGate does not trigger (does not invite a second summary)
    const ctxWithWritesAndText = makeContext({
      unverifiedWrites: new Set(["src/auth.ts"]),
      checkAvailable: true,
      stepResult: {
        text: "I finished the edits.",
        finishReason: "stop",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, promptTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        blockedOnQuestion: false,
      },
    });
    expect(await completionGateHook.after(ctxWithWritesAndText)).toEqual({ action: "continue" });

    // If tool calls were made in this step, completionGate does not trigger
    const ctxWithTools = makeContext({
      unverifiedWrites: new Set(["src/auth.ts"]),
      checkAvailable: true,
      stepResult: {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [{ id: "c1", name: "read", input: {} }],
        usage: { inputTokens: 0, outputTokens: 0, promptTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        blockedOnQuestion: false,
      },
    });
    expect(await completionGateHook.after(ctxWithTools)).toEqual({ action: "continue" });
  });

  test("6. contextPressureHook: compacts when the LAST STEP's input tokens (not the cumulative total) cross 80% watermark (D3)", async () => {
    const ctxBelow = makeContext({ contextMax: 100_000, lastStepInputTokens: 60_000 });
    expect(await contextPressureHook.after(ctxBelow)).toEqual({ action: "continue" });

    const ctxAbove = makeContext({ contextMax: 100_000, lastStepInputTokens: 85_000 });
    const verdict = await contextPressureHook.after(ctxAbove);
    expect(verdict.action).toBe("compact");
  });

  test("6b. contextPressureHook: a huge cumulative usageTotals at real 10% occupancy never compacts (D3 regression)", async () => {
    // 8 steps of a 20k prompt on a 200k-context model: cumulative total is 160k (over watermark),
    // but real occupancy (the last step's own input tokens) is ~20k — 10%, nowhere near it.
    const ctx = makeContext({
      contextMax: 200_000,
      usageTotals: {
        inputTokens: 160_000,
        outputTokens: 8_000,
        noCacheTokens: 160_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
      lastStepInputTokens: 20_000,
    });
    expect(await contextPressureHook.after(ctx)).toEqual({ action: "continue" });
  });

  test("6c. contextPressureHook: refuses to re-fire on a transcript that hasn't grown since the last compaction", async () => {
    const ctx = makeContext({
      contextMax: 100_000,
      lastStepInputTokens: 90_000,
      compactionGuard: { entryCountAtLastCompaction: 12, currentEntryCount: 12 },
    });
    expect(await contextPressureHook.after(ctx)).toEqual({ action: "continue" });

    const grown = makeContext({
      contextMax: 100_000,
      lastStepInputTokens: 90_000,
      compactionGuard: { entryCountAtLastCompaction: 12, currentEntryCount: 14 },
    });
    expect((await contextPressureHook.after(grown)).action).toBe("compact");
  });

  test("7. blockedOnQuestionHook: stops when clarify called", async () => {
    const ctx = makeContext({
      stepResult: {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, promptTokens: 0, noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        blockedOnQuestion: true,
      },
    });
    expect(await blockedOnQuestionHook.after(ctx)).toEqual({
      action: "stop",
      state: "blocked-on-permission",
      note: "blocked-on-question",
    });
  });

  test("Priority order: earlier hook wins over later hook", async () => {
    // Both aborted (1) and budget (3) apply -> aborted (1) wins
    const controller = new AbortController();
    controller.abort();
    const budget = new BudgetController("ask");
    for (let i = 0; i < 4; i++) budget.nextStep();

    const ctx = makeContext({ signal: controller.signal, budget });
    const verdict = await runStepHooks(ctx);
    expect(verdict).toEqual({ action: "stop", state: "interrupted-by-user" });
  });

  test("D10/MD3: a clarify call that also trips the watermark still ends the run blocked-on-permission, not compact", async () => {
    const ctx = makeContext({
      contextMax: 100_000,
      lastStepInputTokens: 95_000, // over the 80% watermark
      stepResult: {
        text: "",
        finishReason: "tool_calls",
        toolCalls: [],
        usage: { inputTokens: 95_000, outputTokens: 0, promptTokens: 95_000, noCacheTokens: 95_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
        blockedOnQuestion: true,
      },
    });
    const verdict = await runStepHooks(ctx);
    expect(verdict).toEqual({ action: "stop", state: "blocked-on-permission", note: "blocked-on-question" });
  });

  test("BUILTIN_HOOKS priority order: all 4 stop hooks precede all 3 shaping hooks, contextPressure last", () => {
    const stopHookNames = new Set(["aborted", "repeatedToolCall", "budget", "blockedOnQuestion"]);
    const names = BUILTIN_HOOKS.map((h) => h.name);
    const firstShapingIdx = names.findIndex((n) => !stopHookNames.has(n));
    for (let i = 0; i < firstShapingIdx; i++) expect(stopHookNames.has(names[i])).toBe(true);
    for (let i = firstShapingIdx; i < names.length; i++) expect(stopHookNames.has(names[i])).toBe(false);
    expect(names.at(-1)).toBe("contextPressure");
  });
});
