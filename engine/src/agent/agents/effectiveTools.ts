import type { ChatMode } from "@rama/protocol";
import type { ToolSet } from "ai";
import type { AgentDef } from "./types";

// Static risk ceiling for the fixed harness tool set (engine/src/tools/index.ts's createTools) —
// used only to decide whether a *mode* ever offers a tool at all, mirroring the risk
// permissions.ts's gate() already enforces at call time so a tool plan mode would hard-block is
// never even listed instead of being offered and then refused. bash/heku_call's real per-call
// risk is dynamic (tools/risk.ts, heku/policy.ts) — this is a ceiling for list-membership only;
// gate() remains the actual enforcement.
const HARNESS_TOOL_RISK: Record<string, "low" | "high"> = {
  read: "low",
  glob: "low",
  grep: "low",
  tree: "low",
  outline: "low",
  git: "low",
  check: "low",
  todo: "low",
  explore: "low",
  review: "low",
  clarify: "low",
  write: "high",
  edit: "high",
  file_op: "high",
  bash: "high",
  process: "high",
  browser: "high",
  git_write: "high",
  test: "high", // writes files, even though it's scoped to test paths (tools/test.ts)
};

// Tools outside the fixed harness set (skill_*, heku_find, heku_call, and any future dynamic
// tool) are never narrowed by an agent's allowlist and never removed by mode here — skills and
// external tools are a different access model (§5.3's closing line: "skills are verbs, agents are
// hats") and stay subject only to gate()'s existing per-call risk check.
function isHarnessTool(name: string): boolean {
  return name in HARNESS_TOOL_RISK;
}

function modeForbids(name: string, mode: ChatMode): boolean {
  return mode === "plan" && HARNESS_TOOL_RISK[name] === "high";
}

// docs/PROMPT_STACK_PLAN.md §5.2 — "the effective toolset is harness tools ∩ mode allowance ∩
// agent allowlist." `agent.tools === null` means unrestricted (no narrowing beyond mode); a
// non-null allowlist can only narrow, never add back a tool mode has forbidden (rule 1 + rule 2,
// enforced here — the one place that decides what the model is even offered, not just what gate()
// will let it actually call).
export function computeEffectiveTools(tools: ToolSet, mode: ChatMode, agent: AgentDef): ToolSet {
  const allowed = agent.tools ? new Set(agent.tools) : null;
  const out: ToolSet = {};
  for (const [name, def] of Object.entries(tools)) {
    if (isHarnessTool(name)) {
      if (modeForbids(name, mode)) continue;
      if (allowed && !allowed.has(name)) continue;
    }
    out[name] = def;
  }
  return out;
}
