// docs/PROVIDERS_PLAN.md Phase P2 — resolving the `utility` role: a cheap, fast model for
// background work (auto-titling today; tagging/compaction later). This never touches the `chat`
// role or a chat's own model — purely which model receives background calls.
import { getModelRole, setModelRole } from "../db/modelRoles";
import { listProviderModels } from "../db/providerModels";
import { getProvider, listProviders } from "../db/providers";
import { getCatalog, getCatalogProvider } from "./catalog";

export interface UtilityTarget {
  providerId: string;
  model: string;
}

// Ollama is free and private but unloads a model after ~5m idle, so a cold utility call can take
// ~10s — it must never be silently auto-picked. It only becomes the utility model once a human
// assigns it in settings, and that row has to say why (see SettingsModal's role UI).
const AUTO_DEFAULT_EXCLUDED_PROVIDERS = new Set(["ollama"]);

function isProviderHealthy(providerId: string): boolean {
  return getProvider(providerId)?.last_health_status === "ok";
}

function candidateFromCatalogHint(providerId: string): UtilityTarget | null {
  const hint = getCatalogProvider(providerId)?.utilityModel;
  if (!hint) return null;
  const match = listProviderModels(providerId).find((m) => m.id === hint);
  if (!match || match.status === "missing" || match.status === "erroring") return null;
  return { providerId, model: match.id };
}

function cheapestSmallModel(providerId: string): UtilityTarget | null {
  const candidates = listProviderModels(providerId).filter(
    (m) => m.tier === "small" && m.status !== "missing" && m.status !== "erroring",
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.pricing?.inputPerMillion ?? Infinity) - (b.pricing?.inputPerMillion ?? Infinity));
  return { providerId, model: candidates[0].id };
}

// Preference order: whichever provider already holds `chat` (so nobody needs a second key just
// to name a chat), then every other catalog provider. Within a provider: the catalog's explicit
// `utilityModel` hint, else its cheapest `tier: small` model.
function computeDefaultUtilityTarget(): UtilityTarget | null {
  const chatProviderId = getModelRole("chat")?.provider_id;
  const rest = getCatalog()
    .providers.map((p) => p.id)
    .filter((id) => id !== chatProviderId);
  const order = chatProviderId ? [chatProviderId, ...rest] : rest;

  for (const providerId of order) {
    if (AUTO_DEFAULT_EXCLUDED_PROVIDERS.has(providerId)) continue;
    if (!isProviderHealthy(providerId)) continue;
    const candidate = candidateFromCatalogHint(providerId) ?? cheapestSmallModel(providerId);
    if (candidate) return candidate;
  }
  return null;
}

// Idempotent and cheap — a no-op the instant a human (or an earlier call) has ever set the role.
// Safe to call on every boot and every "a provider key was just saved" event.
export function maybeDefaultUtilityRole(): void {
  if (getModelRole("utility")) return;
  const target = computeDefaultUtilityTarget();
  if (target) setModelRole("utility", target.providerId, target.model);
}

// docs/PROVIDERS_PLAN.md Phase P5 — "first run ... routes to this flow instead." Fast-add (P4)
// and the wizard (P5) can both configure a provider with enabled models without ever touching
// General settings, and config.ts's getChatRoleModel() falls back to a hardcoded provider id that,
// post-Phase P3, may not exist at all. Mirrors maybeDefaultUtilityRole's shape: a no-op the
// instant a human (or an earlier call) has ever set the role, so it's safe on every boot and every
// provider-configuring route. Picks the oldest configured, enabled provider's first enabled,
// non-broken model — good enough for "there is now exactly one provider", which is the only case
// this actually needs to get right; a second provider showing up later never touches an
// already-set role.
export function maybeDefaultChatRole(): void {
  if (getModelRole("chat")) return;
  for (const provider of listProviders()) {
    if (!provider.enabled) continue;
    const model = provider.models.find((m) => m.enabled && m.status !== "missing" && m.status !== "erroring");
    if (model) {
      setModelRole("chat", provider.id, model.id);
      return;
    }
  }
}

// The titling call's read path. Returns null — not a guess — whenever there's truly nothing safe
// to call right now, which is exactly when the caller should skip silently rather than fall back.
export function getUtilityTarget(): UtilityTarget | null {
  const role = getModelRole("utility");
  if (!role) return null;
  if (!isProviderHealthy(role.provider_id)) return null;
  return { providerId: role.provider_id, model: role.model_id };
}
