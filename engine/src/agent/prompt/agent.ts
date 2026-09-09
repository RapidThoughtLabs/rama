import type { AgentDef } from "../agents/types";

// docs/PROMPT_STACK_PLAN.md §5.1/§4.1, Phase PS4 — layer 2, the user-authored half of bp2
// ("agent + mode"). Rendered before the mode text in build.ts (§4.1's layer order: agent is
// layer 2, mode is layer 3), so mode's authority text is always the closing word — an agent
// file's own prose can shape role/voice/priorities but never gets the last word on what it may
// actually do. Empty body (the bundled `default` agent's floor case) renders nothing.
export function buildAgentBlock(agent: AgentDef): string {
  if (!agent.body) return "";
  const header = agent.description ? `Agent: ${agent.name}. ${agent.description}` : `Agent: ${agent.name}.`;
  return `${header}\n\n${agent.body}`;
}
