// A weak/quantized model can get stuck re-issuing the exact same tool call step after step —
// never producing a finish reason other than "tool-calls" because it never actually reads its
// own result as "done" (observed live: Llama-3.3-70B-Instruct-Turbo via Together answering
// "hello" with `bash echo Hello World` eight times in a row, once per step, until stepCountIs(8)
// cut it off — eight real shell executions and eight duplicate artifacts for one greeting).
// stepCountIs(8) alone doesn't help here since it only caps the budget, it doesn't notice the
// steps inside it are identical. This stop condition ends the loop as soon as the last N steps
// each made exactly one tool call with the same name and input, well before the step budget is
// spent on a call that's already succeeded and isn't going to say anything new.
import type { StopCondition } from "ai";

export const REPEATED_TOOL_CALL_LIMIT = 3;

interface StepLike {
  toolCalls: ReadonlyArray<{ toolName: string; input: unknown }>;
}

function soleToolCallSignature(step: StepLike): string | null {
  if (step.toolCalls.length !== 1) return null;
  const call = step.toolCalls[0];
  return `${call.toolName}:${JSON.stringify(call.input)}`;
}

export function stuckOnRepeatedToolCall(steps: readonly StepLike[], limit: number = REPEATED_TOOL_CALL_LIMIT): boolean {
  if (steps.length < limit) return false;
  const last = steps.slice(-limit);
  const signatures = last.map(soleToolCallSignature);
  if (signatures.some((s) => s === null)) return false;
  return signatures.every((s) => s === signatures[0]);
}

export function hasRepeatedToolCall(limit: number = REPEATED_TOOL_CALL_LIMIT): StopCondition<any, any> {
  return ({ steps }) => stuckOnRepeatedToolCall(steps, limit);
}

export const STUCK_LOOP_NOTE =
  "_Stopped early: the same tool call repeated with no new progress. Try again, rephrase, or switch models._";
