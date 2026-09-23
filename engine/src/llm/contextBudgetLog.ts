// engine/src/llm/contextBudgetLog.ts
//
// TEMPORARY — docs/CONTEXT_BUDGET_PLAN.md Phase CB0.
// One JSONL line per completed LLM request, written from the two stream clients
// (the only place that sees both the outgoing request and the provider's final
// usage numbers). Delete this file and its two call sites once CB0's acceptance
// table is filled in — nothing downstream reads this log at runtime.

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LOG_DIR = join(homedir(), ".rama");
const LOG_PATH = join(LOG_DIR, "context-budget-cb0.jsonl");

export interface ContextBudgetLogEntry {
  provider: "anthropic" | "openai";
  model: string;
  messageCount: number;
  requestBytes: number;
  inputTokens: number;
  /** CB1's cache-inclusive occupancy number — the per-request prompt size curve CB0 wants. */
  promptTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function logContextBudgetStep(entry: ContextBudgetLogEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(LOG_PATH, line + "\n");
  } catch {
    // Best-effort measurement logging — must never break a live request.
  }
}
