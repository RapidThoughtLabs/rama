// docs/CONTEXT_BUDGET_PLAN.md CB4 — resolving the `summarize` role: compaction is a blocking
// mid-run call on the critical path of a turn, so running it on the chat's own frontier model
// costs both frontier price and frontier latency for a job a small fast model does well. Mirrors
// subagentRole.ts's shape exactly (same preference order, same ollama exclusion, same idempotent
// maybeDefault*/get* pair) — same tier list as subagent (`small` then `workhorse`), since a
// compaction call reads a much larger raw-tail chunk than a one-line utility call and can need a
// bigger context window than `utility`'s `small`-only tier ever requires.
import { getModelRole, setModelRole } from "../db/modelRoles";
import { getCatalog } from "./catalog";
import { candidateFromCatalogHint, cheapestModelByTier, isProviderHealthy, type RoleTarget } from "./roleDefaults";

export type SummarizeTarget = RoleTarget;

const AUTO_DEFAULT_EXCLUDED_PROVIDERS = new Set(["ollama"]);

function computeDefaultSummarizeTarget(): SummarizeTarget | null {
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
export function maybeDefaultSummarizeRole(): void {
  if (getModelRole("summarize")) return;
  const target = computeDefaultSummarizeTarget();
  if (target) setModelRole("summarize", target.providerId, target.model);
}

// compact.ts's read path — returns null (not a guess) whenever there's nothing safe to call right
// now, which is exactly when the caller should fall back to the chat's own model rather than fail
// (or stall) a mid-run compaction over a role that was never configured.
export function getSummarizeTarget(): SummarizeTarget | null {
  const role = getModelRole("summarize");
  if (!role) return null;
  if (!isProviderHealthy(role.provider_id)) return null;
  return { providerId: role.provider_id, model: role.model_id };
}
