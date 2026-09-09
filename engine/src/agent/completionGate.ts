// docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — "the harness enforces the pairing" between writes
// and `check`. Two halves, deliberately split like ephemeral.ts's I/O-vs-pure split:
//   - formatUnverifiedWrites is the *display* half (§8.3 strength 2): the always-visible ephemeral
//     line, "N files written · check not run since last edit".
//   - buildCompletionGateNudge is the *enforcement* half (§8.3 strength 3, the between-step hook):
//     a synthetic message injected only when the model tries to finish anyway, forcing one more
//     step. loop.ts owns the actual retry loop — this module only builds the string/message.
import type { ModelMessage } from "ai";
import { buildEphemeralMessage } from "./prompt/ephemeral";

// docs/HARNESS_DESIGN.md L1's "refuses to let a run finish... and injects one more step" is
// deliberately bounded to a single extra step-budget cycle here, not unbounded retries: a model
// that insists a write needs no verification (or whose `check` call itself fails) gets one
// enforced chance, then the run is allowed to end rather than risk hanging forever on a turn the
// harness cannot force to agree with it.
export const MAX_COMPLETION_NUDGES = 1;

export function formatUnverifiedWrites(files: ReadonlySet<string>): string | undefined {
  if (files.size === 0) return undefined;
  const shown = [...files].slice(0, 8);
  const list = shown.join(", ") + (files.size > shown.length ? `, +${files.size - shown.length} more` : "");
  return `${files.size} file${files.size === 1 ? "" : "s"} written · check not run since last edit (${list}).`;
}

const GATE_TAG = "completion-gate";

export function buildCompletionGateNudge(files: ReadonlySet<string>, supportsMidConversationSystem: boolean): ModelMessage {
  const note = formatUnverifiedWrites(files) ?? "Files were written this run and have not been verified.";
  const text =
    `<system-reminder id="${GATE_TAG}">\n` +
    `Before finishing: ${note} Run check now, or say plainly why verification doesn't apply here — then finish.\n` +
    `</system-reminder>`;
  return buildEphemeralMessage(text, supportsMidConversationSystem);
}
