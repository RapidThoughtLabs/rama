// docs/PROMPT_STACK_PLAN.md §7.1, Phase PS3 — layer 4, pure formatting half of "RAMA.md loading,
// global + project, headers." I/O (reading the files, computing the size warning) lives in
// agent/instructions.ts and is done by the caller (loop.ts) — same split as sources.ts's
// getStaticEnv/formatStaticEnv.
export interface ProjectKnowledgeInputs {
  global: string | null;
  project: string | null;
  // docs/COMPOSER_CONTEXT_PLAN.md Phase CC1 — the composer's "+folder" chips: absolute paths, not
  // content. This is deliberately a pointer, never a dump of the folder's contents into context —
  // see the module doc on tools/paths.ts's resolveReadPath for the sandbox half of this.
  extraRoots: string[];
}

export function formatProjectKnowledge(inputs: ProjectKnowledgeInputs): string {
  const parts: string[] = [];
  if (inputs.global) parts.push(`## Global instructions (~/.rama/RAMA.md)\n\n${inputs.global}`);
  if (inputs.project) parts.push(`## Project instructions (RAMA.md)\n\n${inputs.project}`);
  if (inputs.extraRoots.length) {
    const lines = inputs.extraRoots.map((root) => `- ${root}`);
    parts.push(
      "## Additional context folders\n\n" +
        "These are pointers only — nothing under them is loaded into context yet. If the task " +
        "looks like it might relate to one, read/tree/grep into it (absolute paths, read-only — " +
        "edit will refuse there):\n\n" +
        lines.join("\n"),
    );
  }
  return parts.join("\n\n");
}
