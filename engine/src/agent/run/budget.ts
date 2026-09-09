// engine/src/agent/run/budget.ts
//
// Per-run budget tracking: steps, tokens, wall-clock time.
// docs/LOOP_MIGRATION_PLAN.md §6.1, §6.5

import type { ChatMode } from "@rama/protocol";

export interface BudgetConfig {
  maxSteps: number;
  wallClockTimeoutMs?: number;
}

const DEFAULT_BUDGETS: Record<ChatMode, BudgetConfig> = {
  agent: { maxSteps: 8 },
  plan: { maxSteps: 8 },
  ask: { maxSteps: 4 },
};

export class BudgetController {
  private currentStep = 0;
  private readonly maxSteps: number;
  private readonly startTime: number;
  private readonly wallClockTimeoutMs?: number;

  constructor(mode: ChatMode, overrides?: Partial<BudgetConfig>) {
    const config = { ...DEFAULT_BUDGETS[mode], ...overrides };
    this.maxSteps = config.maxSteps;
    this.wallClockTimeoutMs = config.wallClockTimeoutMs;
    this.startTime = Date.now();
  }

  get step(): number {
    return this.currentStep;
  }

  get limit(): number {
    return this.maxSteps;
  }

  /**
   * Attempt to advance to the next step.
   * Returns false if the budget is exhausted.
   */
  nextStep(): boolean {
    if (this.isExhausted()) return false;
    this.currentStep++;
    return true;
  }

  isExhausted(): boolean {
    if (this.currentStep >= this.maxSteps) return true;
    if (this.wallClockTimeoutMs && Date.now() - this.startTime > this.wallClockTimeoutMs) {
      return true;
    }
    return false;
  }
}
