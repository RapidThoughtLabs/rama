import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ChatMode } from "@rama/protocol";
import { RAMA_HOME } from "../../db/index";
import type { ModelRole } from "../../db/modelRoles";
import type { SearchCtx } from "../../search/types";
import { parseAgentMd } from "./frontmatter";
import type { AgentDef } from "./types";

export const AGENTS_HOME = join(RAMA_HOME, "agents");
const BUNDLED_AGENTS_DIR = join(import.meta.dir, "bundled");

export const DEFAULT_AGENT_NAME = "default";

const VALID_MODES = new Set<ChatMode>(["agent", "plan", "ask"]);
const VALID_MODEL_ROLES = new Set<ModelRole>(["chat", "utility", "summarize", "subagent"]);

// docs/PROMPT_STACK_PLAN.md §9.4 PS0's sorting rule applies here too — an agent block only ever
// renders one agent's content, so ordering can't invalidate the cache the way tool ordering can,
// but a stable listing order (for the picker) is still worth the same one-line fix.
function scanAgentsDir(dir: string, source: AgentDef["source"]): AgentDef[] {
  if (!existsSync(dir)) return [];
  const out: AgentDef[] = [];
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const fm = parseAgentMd(readFileSync(path, "utf8"));
    const name = fm.name ?? entry.name.replace(/\.md$/, "");
    const mode = fm.mode && VALID_MODES.has(fm.mode as ChatMode) ? (fm.mode as ChatMode) : null;
    const model = fm.model && VALID_MODEL_ROLES.has(fm.model as ModelRole) ? (fm.model as ModelRole) : "chat";
    out.push({ name, description: fm.description ?? "", tools: fm.tools ?? null, mode, model, source, path, body: fm.body });
  }
  return out;
}

// Three-tier discovery per docs/PROMPT_STACK_PLAN.md §5.3 — bundled ships the matrix floor
// (`default`) plus a couple of worked examples, `~/.rama/agents` adds machine-wide agents,
// `<project>/.rama/agents` adds project-local ones. Most specific wins on name collision, exactly
// like skills/discover.ts:31 — a project can override a bundled or global agent of the same name.
export function discoverAgents(ctx: SearchCtx): AgentDef[] {
  const bundled = scanAgentsDir(BUNDLED_AGENTS_DIR, "bundled");
  const global = scanAgentsDir(AGENTS_HOME, "global");
  const local = ctx.projectPath ? scanAgentsDir(join(ctx.projectPath, ".rama", "agents"), "project") : [];

  const byName = new Map<string, AgentDef>();
  for (const agent of bundled) byName.set(agent.name, agent);
  for (const agent of global) byName.set(agent.name, agent);
  for (const agent of local) byName.set(agent.name, agent);
  return [...byName.values()];
}

// The hardcoded floor, used only if the bundled default.md is somehow missing or unreadable (a
// broken install) — resolveAgent must never return null and leave a chat with no agent block at
// all. In the normal case this is never reached; bundled/default.md wins the lookup below first.
const FALLBACK_DEFAULT: AgentDef = {
  name: DEFAULT_AGENT_NAME,
  description: "No narrowing — full access within whatever the mode allows.",
  tools: null,
  mode: null,
  model: "chat",
  source: "bundled",
  path: "(builtin fallback)",
  body: "",
};

// Always returns something — an unresolvable chat.agentId (a project-local agent whose file was
// deleted, a typo'd row from before validation existed) falls back to `default` rather than
// erroring the run over a picker concern.
export function resolveAgent(ctx: SearchCtx, agentId: string | null | undefined): AgentDef {
  const agents = discoverAgents(ctx);
  const requested = agentId ? agents.find((a) => a.name === agentId) : undefined;
  if (requested) return requested;
  return agents.find((a) => a.name === DEFAULT_AGENT_NAME) ?? FALLBACK_DEFAULT;
}
