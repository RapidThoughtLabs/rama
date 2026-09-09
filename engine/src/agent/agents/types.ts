import type { ChatMode } from "@rama/protocol";
import type { ModelRole } from "../../db/modelRoles";

// docs/PROMPT_STACK_PLAN.md §5.3, Phase PS4 — one parsed agent definition file. `tools: null`
// means unrestricted (no narrowing beyond whatever mode already allows); a non-null list can only
// narrow further, never widen past mode or the harness's real tool set — see effectiveTools.ts.
export interface AgentDef {
  name: string;
  description: string;
  tools: string[] | null;
  /** Preferred default mode — a UI hint, never binding (§5.2 rule 2: an agent file cannot set
   *  mode/risk/permission rules). null = no preference. */
  mode: ChatMode | null;
  /** A role name, never a model id — resolved against model_roles at call time. */
  model: ModelRole;
  source: "bundled" | "global" | "project";
  path: string;
  /** The markdown body below the frontmatter — role, voice, priorities, conventions (layer 2). */
  body: string;
}
