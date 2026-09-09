// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — layer 4, pure formatting half of "RAMA.md loading,
// global + project, headers." I/O (reading the files, computing the size warning) lives in
// agent/instructions.ts and is done by the caller (loop.ts) — same split as sources.ts's
// getStaticEnv/formatStaticEnv.
export interface ProjectKnowledgeInputs {
  global: string | null;
  project: string | null;
}

export function formatProjectKnowledge(inputs: ProjectKnowledgeInputs): string {
  const parts: string[] = [];
  if (inputs.global) parts.push(`## Global instructions (~/.rama/RAMA.md)\n\n${inputs.global}`);
  if (inputs.project) parts.push(`## Project instructions (RAMA.md)\n\n${inputs.project}`);
  return parts.join("\n\n");
}
