// docs/PROMPT_STACK_PLAN.md §4.2/§5.2, Phase PS4 — resolves a real tension between two of the
// plan's own constraints: "switching agent keeps the tools+kernel cache warm" (bp1 must stay
// agent-invariant) vs. kernel.ts's own promise that the tool list is "what you can actually call
// this turn". bp1 stays a stable, mode/agent-invariant *capability* inventory (this build's real
// tool map); this note — rendered in bp2, which already varies with agent+mode — is where the
// turn-scoped truth actually lives. Omitted entirely when nothing is narrowed, so the common case
// (default agent, agent mode) costs nothing.
export function formatEffectiveToolsNote(effectiveNames: string[], allNames: string[]): string {
  const effSet = new Set(effectiveNames);
  const narrowed = allNames.length !== effectiveNames.length || !allNames.every((n) => effSet.has(n));
  if (!narrowed) return "";
  return (
    `Your actual toolset this turn, narrowed from the full inventory above by the current mode and ` +
    `agent: ${effectiveNames.length > 0 ? effectiveNames.join(", ") : "(none — read-only investigation only)"}. ` +
    "A tool listed above but not here is not available to you right now."
  );
}
