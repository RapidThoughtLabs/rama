// engine/src/agent/run/hooks.ts
//
// HARNESS_DESIGN.md L1, docs/LOOP_MIGRATION_PLAN.md §6.4 (order revised by
// docs/LOOP_MENDING_PLAN.md D10/MD3 — see the note below)
//
// The between-step hook interface and the 7 built-in hooks, in priority order:
// 1. aborted: stop -> "interrupted-by-user"
// 2. repeatedToolCall: stop -> "stopped-loop-detected"
// 3. budget: stop -> "stopped-by-budget"
// 4. blockedOnQuestion: stop -> "blocked-on-permission"
// 5. steering: inject queued user message
// 6. completionGate: inject completion-gate nudge
// 7. contextPressure: compact above the watermark (LM5)
//
// docs/LOOP_MENDING_PLAN.md D10/MD3 — blockedOnQuestion used to run last (after
// contextPressure), so a step that called `clarify` while also over the watermark got its
// "stop" verdict silently discarded in favor of "compact". The ordering principle: verdicts
// that END the run outrank verdicts that only SHAPE it. All four "stop" hooks (aborted,
// repeatedToolCall, budget, blockedOnQuestion) now run before any "inject"/"compact" hook;
// contextPressure — the only "compact" verdict — runs last of all, since it never has an
// opinion about whether the run should keep going, only about what the next request looks
// like. This is a correction to LOOP_MIGRATION_PLAN.md §6.4's table, not a deviation from it —
// that table's order is what produced the defect, so it must not be read as still current.

import type { TerminalState } from "@rama/protocol";
import { newId } from "../../db/ids";
import { buildCompletionGateNudgeText } from "../completionGate";
import { type StepLike, stuckOnRepeatedToolCall, STUCK_LOOP_NOTE } from "../loopGuard";
import type { BudgetController } from "./budget";
import type { StepResult } from "./step";
import type { TranscriptEntry } from "./transcript";

// ---------------------------------------------------------------------------
// Hook types
// docs/LOOP_MIGRATION_PLAN.md §6.4
// ---------------------------------------------------------------------------

export type HookVerdict =
  | { action: "continue" }
  | { action: "inject"; entry: TranscriptEntry } // force another step
  | { action: "compact"; reason: string } // LM5
  | { action: "stop"; state: TerminalState; note?: string };

export interface StepHookContext {
  chatId: string;
  runId: string;
  signal: AbortSignal;
  budget: BudgetController;
  stepsHistory: readonly StepLike[];
  stepResult: StepResult;
  unverifiedWrites: ReadonlySet<string>;
  checkAvailable: boolean;
  usageTotals: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    noCacheTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /**
   * The step that just ran's own `usage.inputTokens` — actual context occupancy at request time,
   * not `usageTotals.totalTokens`'s running sum across every step of the run. This is the only
   * field contextPressureHook may read for its watermark check.
   * docs/LOOP_MENDING_PLAN.md D3/MD2.
   */
  lastStepInputTokens: number;
  /**
   * Lets contextPressureHook refuse to re-fire on a transcript that hasn't grown since the last
   * compaction in this run — compaction cannot lower an occupancy reading a second time if the
   * transcript is exactly what it just summarized. `null` means "never compacted this run".
   * docs/LOOP_MENDING_PLAN.md D3/MD2.
   */
  compactionGuard?: { entryCountAtLastCompaction: number | null; currentEntryCount: number };
  contextMax?: number;
  watermark?: number;
  dequeueSteering?: () => string | undefined;
}

export interface StepHook {
  name: string;
  after(ctx: StepHookContext): Promise<HookVerdict> | HookVerdict;
}

// ---------------------------------------------------------------------------
// Steering Queue (H4)
// docs/LOOP_MIGRATION_PLAN.md §6.4:
// A per-chat pending-message queue. sendUserTurn mid-run enqueues here,
// and hook 4 injects at the step boundary.
// ---------------------------------------------------------------------------

const steeringQueues = new Map<string, string[]>();

export function enqueueSteeringMessage(chatId: string, text: string): void {
  const queue = steeringQueues.get(chatId) ?? [];
  queue.push(text);
  steeringQueues.set(chatId, queue);
}

export function dequeueSteeringMessage(chatId: string): string | undefined {
  const queue = steeringQueues.get(chatId);
  if (!queue || queue.length === 0) return undefined;
  const item = queue.shift();
  if (queue.length === 0) steeringQueues.delete(chatId);
  return item;
}

export function clearSteeringQueue(chatId: string): void {
  steeringQueues.delete(chatId);
}

// ---------------------------------------------------------------------------
// Built-in Hooks (ordered 1 to 7 per §6.4)
// ---------------------------------------------------------------------------

/** 1. aborted: Stop when user interrupts the run */
export const abortedHook: StepHook = {
  name: "aborted",
  after(ctx) {
    if (ctx.signal.aborted) {
      return { action: "stop", state: "interrupted-by-user" };
    }
    return { action: "continue" };
  },
};

/** 2. repeatedToolCall: Stop when the model gets stuck repeating the same call */
export const repeatedToolCallHook: StepHook = {
  name: "repeatedToolCall",
  after(ctx) {
    if (stuckOnRepeatedToolCall(ctx.stepsHistory)) {
      return { action: "stop", state: "stopped-loop-detected", note: STUCK_LOOP_NOTE };
    }
    return { action: "continue" };
  },
};

/** 3. budget: Stop when step or wall-clock budget is spent */
export const budgetHook: StepHook = {
  name: "budget",
  after(ctx) {
    if (ctx.budget.isExhausted()) {
      return { action: "stop", state: "stopped-by-budget" };
    }
    return { action: "continue" };
  },
};

/**
 * 4. blockedOnQuestion: Clarify ends turn immediately.
 * Runs ahead of the shaping hooks (steering/completionGate/contextPressure) — it's a "stop"
 * verdict, and a stop must never be silently discarded by a "compact" verdict from a later hook
 * in the same pass. docs/LOOP_MENDING_PLAN.md D10/MD3.
 */
export const blockedOnQuestionHook: StepHook = {
  name: "blockedOnQuestion",
  after(ctx) {
    if (ctx.stepResult.blockedOnQuestion) {
      return { action: "stop", state: "blocked-on-permission", note: "blocked-on-question" };
    }
    return { action: "continue" };
  },
};

/** 5. steering: Inject queued mid-run user message at the step boundary */
export const steeringHook: StepHook = {
  name: "steering",
  after(ctx) {
    const text = ctx.dequeueSteering ? ctx.dequeueSteering() : dequeueSteeringMessage(ctx.chatId);
    if (text) {
      return {
        action: "inject",
        entry: {
          kind: "injected",
          id: newId(),
          role: "user",
          text,
          tag: `steering-${newId()}`,
          ttl: "run",
        },
      };
    }
    return { action: "continue" };
  },
};

/** 6. completionGate: Nudge to verify writes with check before finishing */
export const completionGateHook: StepHook = {
  name: "completionGate",
  after(ctx) {
    if (
      ctx.stepResult.toolCalls.length === 0 &&
      ctx.checkAvailable &&
      ctx.unverifiedWrites.size > 0
    ) {
      return {
        action: "inject",
        entry: {
          kind: "injected",
          id: newId(),
          role: "system",
          text: buildCompletionGateNudgeText(ctx.unverifiedWrites),
          tag: "completion-gate",
          ttl: "step",
        },
      };
    }
    return { action: "continue" };
  },
};

/**
 * 7. contextPressure: Preemptive compaction trigger above watermark (LM5)
 *
 * Reads `lastStepInputTokens` — the last request's actual prompt size — never
 * `usageTotals.totalTokens`, which is a running sum across every step of the run and keeps
 * climbing even as real context occupancy shrinks after a compaction (D3). Also refuses to
 * re-fire on a transcript that hasn't grown since the last compaction: compacting again would
 * summarize the same summary, one step's worth of budget for no measurable effect.
 * docs/LOOP_MENDING_PLAN.md D3/MD2.
 */
export const contextPressureHook: StepHook = {
  name: "contextPressure",
  after(ctx) {
    if (!ctx.contextMax) return { action: "continue" };
    const watermark = ctx.watermark ?? Math.floor(ctx.contextMax * 0.8);
    if (ctx.lastStepInputTokens < watermark) return { action: "continue" };

    const guard = ctx.compactionGuard;
    if (guard && guard.entryCountAtLastCompaction != null && guard.currentEntryCount <= guard.entryCountAtLastCompaction) {
      return { action: "continue" };
    }

    return {
      action: "compact",
      reason: `context pressure: last step's input tokens (${ctx.lastStepInputTokens}) reached watermark (${watermark})`,
    };
  },
};

// ---------------------------------------------------------------------------
// Hook Runner: fixed priority order (docs/LOOP_MENDING_PLAN.md D10/MD3 — revises
// LOOP_MIGRATION_PLAN.md §6.4's table; see the module comment above)
// ---------------------------------------------------------------------------

export const BUILTIN_HOOKS: readonly StepHook[] = [
  abortedHook,
  repeatedToolCallHook,
  budgetHook,
  blockedOnQuestionHook,
  steeringHook,
  completionGateHook,
  contextPressureHook,
];

/**
 * Run hooks in fixed order after every step. First non-"continue" verdict wins.
 */
export async function runStepHooks(
  ctx: StepHookContext,
  hooks: readonly StepHook[] = BUILTIN_HOOKS
): Promise<HookVerdict> {
  for (const hook of hooks) {
    const verdict = await hook.after(ctx);
    if (verdict.action !== "continue") {
      return verdict;
    }
  }
  return { action: "continue" };
}
