import type { WireMessage } from "../../llm/types";
import { getStatus, isGitRepo } from "../../tools/gitShared";

// docs/PROMPT_STACK_PLAN.md §4.1/§4.2, Phase PS2 — layer 7, the real C9 ephemeral layer. Separate
// from tools/todo.ts's todoEphemeralBlock, which stays exactly as it is: that mechanism already
// works and re-renders per *step* (not per turn), so folding it into this per-turn block is left
// to a later phase rather than risking today's working behavior. `budget` below remains that
// future slot — present in the type, deliberately never populated ("reserved, unwired" per
// docs/PROMPT_STACK_PLAN.md §10 PS2). `taskComplexityHint`/`unverifiedWrites` are PS6's use of the
// same reserved-slot pattern: §8.1 "the result drives the ephemeral block, never the system
// prompt" and §8.3's "7 files edited · check not run since last edit" example.
export interface VolatileEnv {
  date: string;
  git: { branch: string; dirty: boolean } | null;
}

// I/O half — mirrors sources.ts's getStaticEnv/formatStaticEnv split, just async because git
// status needs a subprocess. Called once per run (loop.ts), never per step.
export async function getVolatileEnv(projectPath: string): Promise<VolatileEnv> {
  const date = new Date().toISOString().slice(0, 10);
  if (!(await isGitRepo(projectPath))) return { date, git: null };
  const status = await getStatus(projectPath);
  const dirty = status.staged.length + status.unstaged.length + status.untracked.length > 0;
  const branch = status.detached ? "(detached HEAD)" : (status.branch ?? "(unknown)");
  return { date, git: { branch, dirty } };
}

export function formatVolatileEnv(env: VolatileEnv): string {
  const gitPart = env.git ? `git branch ${env.git.branch}, ${env.git.dirty ? "dirty" : "clean"}` : "not a git repository";
  return `Date: ${env.date}. ${gitPart}.`;
}

export interface EphemeralInputs {
  volatileEnv: VolatileEnv;
  /** PS6 §8.1 — set only on the first user turn, only when the complexity classifier
   *  (agent/complexity.ts) returns "complex". Constant for the whole run once computed. */
  taskComplexityHint?: string;
  /** PS6 §8.3 — "N files written · check not run since last edit". Recomputed fresh on every
   *  step (unlike the fields above), since it tracks live per-run tool-call state. */
  unverifiedWrites?: string;
  /** Reserved slot — see the module comment above. Always undefined this phase. */
  todo?: string;
  budget?: string;
}

const EPHEMERAL_TAG = "ephemeral-env";

// Pure — build.ts's sibling for the uncached tail. Not part of buildPrompt: this never sits in
// `system`, it's appended fresh (from a per-run-computed string, not re-fetched) as the very last
// message of every step, after prepareStep's cache-boundary marker (loop.ts), so it always trails
// the cached prefix instead of invalidating it.
export function buildEphemeralText(inputs: EphemeralInputs): string {
  const parts = [formatVolatileEnv(inputs.volatileEnv), inputs.taskComplexityHint, inputs.unverifiedWrites, inputs.todo, inputs.budget].filter(
    (p): p is string => !!p,
  );
  return `<system-reminder id="${EPHEMERAL_TAG}">\n${parts.join("\n\n")}\n</system-reminder>`;
}

// §4.2's fallback: "mid-conversation role:'system' messages are not universally supported
// (notably not on Claude Sonnet 5) ... a text-block fallback appended to the user turn." The
// fallback is weaker (S4: a user-role message is technically forgeable content), but it's the
// only channel every model actually accepts.
export function buildEphemeralMessage(text: string, supportsMidConversationSystem: boolean): WireMessage {
  return supportsMidConversationSystem ? { role: "system", content: text } : { role: "user", content: text };
}
