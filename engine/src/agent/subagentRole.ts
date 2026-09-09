// docs/PROMPT_STACK_PLAN.md §6.1, Phase PS5 — resolving the `subagent` role: "defaulted from the
// catalog's tier: small/workhorse hint the same way utility is." Mirrors utility.ts's shape
// exactly (same preference order, same ollama exclusion, same idempotent maybeDefault*/get*
// pair) — the one real difference is the tier list: a sub-agent doing real investigation work
// tolerates a workhorse-tier model when no small one exists, where utility (a one-line title
// call) never needs to reach past `small`.
import { getModelRole, setModelRole } from "../db/modelRoles";
import { getCatalog } from "./catalog";
import { candidateFromCatalogHint, cheapestModelByTier, isProviderHealthy, type RoleTarget } from "./roleDefaults";

export type SubagentTarget = RoleTarget;

const AUTO_DEFAULT_EXCLUDED_PROVIDERS = new Set(["ollama"]);

function computeDefaultSubagentTarget(): SubagentTarget | null {
  const chatProviderId = getModelRole("chat")?.provider_id;
  const rest = getCatalog()
    .providers.map((p) => p.id)
    .filter((id) => id !== chatProviderId);
  const order = chatProviderId ? [chatProviderId, ...rest] : rest;

  for (const providerId of order) {
    if (AUTO_DEFAULT_EXCLUDED_PROVIDERS.has(providerId)) continue;
    if (!isProviderHealthy(providerId)) continue;
    const candidate = candidateFromCatalogHint(providerId) ?? cheapestModelByTier(providerId, ["small", "workhorse"]);
    if (candidate) return candidate;
  }
  return null;
}

// Idempotent and cheap — a no-op the instant a human (or an earlier call) has ever set the role.
// Safe to call on every boot and every "a provider key was just saved" event.
export function maybeDefaultSubagentRole(): void {
  if (getModelRole("subagent")) return;
  const target = computeDefaultSubagentTarget();
  if (target) setModelRole("subagent", target.providerId, target.model);
}

// loop.ts's read path — returns null (not a guess) whenever there's nothing safe to call right
// now, which is exactly when the caller should fall back to the parent turn's own model rather
// than fail the sub-agent tool outright over a role that was never configured.
export function getSubagentTarget(): SubagentTarget | null {
  const role = getModelRole("subagent");
  if (!role) return null;
  if (!isProviderHealthy(role.provider_id)) return null;
  return { providerId: role.provider_id, model: role.model_id };
}
