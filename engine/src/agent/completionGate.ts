// docs/PROMPT_STACK_PLAN.md §8.3, Phase PS6 — "the harness enforces the pairing" between writes
// and `check`. Two halves, deliberately split like ephemeral.ts's I/O-vs-pure split:
//   - formatUnverifiedWrites is the *display* half (§8.3 strength 2): the always-visible ephemeral
//     line, "N files written · check not run since last edit".
//   - buildCompletionGateNudgeText is the *enforcement* half (§8.3 strength 3, the between-step
//     hook): a synthetic message injected only when the model tries to finish anyway, forcing one
//     more step. hooks.ts owns the actual retry wiring — this module only builds the string.

// In Phase LM4, completion gate is re-expressed as an `inject` hook; the step budget is the bound.


export function formatUnverifiedWrites(files: ReadonlySet<string>): string | undefined {
  if (files.size === 0) return undefined;
  const shown = [...files].slice(0, 8);
  const list = shown.join(", ") + (files.size > shown.length ? `, +${files.size - shown.length} more` : "");
  return `${files.size} file${files.size === 1 ? "" : "s"} written · check not run since last edit (${list}).`;
}

export const GATE_TAG = "completion-gate";

export function buildCompletionGateNudgeText(files: ReadonlySet<string>): string {
  const note = formatUnverifiedWrites(files) ?? "Files were written this run and have not been verified.";
  return (
    `<system-reminder id="${GATE_TAG}">\n` +
    `Before finishing: ${note} Run check now, or say plainly why verification doesn't apply here — then finish.\n` +
    `</system-reminder>`
  );
}
