// Shared plumbing behind "auto-default a background model role from the catalog", factored out
// of utility.ts (docs/PROVIDERS_PLAN.md Phase P2) so subagentRole.ts (docs/PROMPT_STACK_PLAN.md
// §6.1, Phase PS5) doesn't reimplement the same provider-health/tier-price logic. Both callers
// keep their own preference-order and excluded-providers policy; only the per-provider "what's
// the cheapest usable model" question lives here.
import { listProviderModels } from "../db/providerModels";
import { getProvider } from "../db/providers";
import { getCatalogProvider, type CatalogTier } from "./catalog";

export interface RoleTarget {
  providerId: string;
  model: string;
}

export function isProviderHealthy(providerId: string): boolean {
  return getProvider(providerId)?.last_health_status === "ok";
}

export function candidateFromCatalogHint(providerId: string): RoleTarget | null {
  const hint = getCatalogProvider(providerId)?.utilityModel;
  if (!hint) return null;
  const match = listProviderModels(providerId).find((m) => m.id === hint);
  if (!match || match.status === "missing" || match.status === "erroring") return null;
  return { providerId, model: match.id };
}

// Cheapest enabled, non-broken model among the given tiers (in the order given — a `["small",
// "workhorse"]` call still prefers a small model over a workhorse one at the same price, since
// tiers earlier in the array are considered first and price only breaks ties within a tier).
export function cheapestModelByTier(providerId: string, tiers: CatalogTier[]): RoleTarget | null {
  for (const tier of tiers) {
    const candidates = listProviderModels(providerId).filter(
      (m) => m.tier === tier && m.status !== "missing" && m.status !== "erroring",
    );
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => (a.pricing?.inputPerMillion ?? Infinity) - (b.pricing?.inputPerMillion ?? Infinity));
    return { providerId, model: candidates[0].id };
  }
  return null;
}
