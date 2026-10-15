import { WHALE_VERBS } from "../../home/actLabels";

/* What the working line says — docs/CODE_REDESIGN_PLAN.md CR6 (mock:L358-360, 1618). While the engine
   is just thinking, the generic verb rotates every two seconds through the mockup's whale verbs and
   the old playful list. Anything specific ("compacting", a running tool, waiting for an answer)
   is said in plain sentence case instead and never swapped for a playful one. */

// docs/COMPOSER_CONTEXT_PLAN.md CC0's list, kept with the mockup's whale verbs added in front.
const PLAYFUL = [
  "Ramaing", "Hullaballooing", "Tinkering", "Percolating", "Noodling", "Ruminating", "Marinating", "Puzzling",
  "Combobulating", "Cogitating", "Spelunking", "Wrangling", "Mulling", "Contemplating", "Pondering", "Synthesizing",
  "Deliberating", "Brewing", "Concocting", "Untangling", "Sussing it out", "Thinking longer",
];
export const THINKING_VERBS = [...WHALE_VERBS, ...PLAYFUL];

/** Cycles off the run's elapsed time rather than a timer of its own, so a phase that re-enters
 *  "thinking" after a tool call picks up where the cycle already was. */
export function pickThinkingVerb(elapsedSeconds: number): string {
  return THINKING_VERBS[Math.floor(Math.max(0, elapsedSeconds) / 2) % THINKING_VERBS.length]!;
}

export interface WorkingInput {
  state: string;
  /** The engine's own word: "thinking", "responding", "compacting", "running bash". */
  verb?: string;
  /** The running call's row label in the present tense, when there is one ("Running bun test"). */
  runningLabel?: string;
  elapsedSeconds: number;
}

export function workingVerb({ state, verb, runningLabel, elapsedSeconds }: WorkingInput): string {
  if (state === "waiting_permission") return "Waiting for your OK";
  const v = verb ?? state;
  if (v === "compacting") return "Compacting the conversation";
  if (v === "responding") return "Writing";
  if (state === "tool" || v.startsWith("running")) return runningLabel || "Working on it";
  return pickThinkingVerb(elapsedSeconds);
}

/** The tooltip that replaces the old status line's counters (plan §9.6): time, tokens, thinking. */
export function workingTitle(elapsedSeconds: number, streamedTokens: number, thinkingSeconds: number): string {
  return [`${elapsedSeconds}s`, `↓ ${streamedTokens} tokens`, thinkingSeconds >= 1 ? `thought for ${thinkingSeconds}s` : ""].filter(Boolean).join(" · ");
}
