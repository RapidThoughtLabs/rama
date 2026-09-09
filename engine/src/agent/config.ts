// Default provider/model for new chats, plus model listing + cost estimation, which now read
// through engine/src/db/providerModels.ts (the provider_models table) instead of the static
// MODEL_REGISTRY this file used to own — see docs/PROVIDERS_PLAN.md Phase P0.

import type { ModelInfo } from "@rama/protocol";
import { getModelRole } from "../db/modelRoles";
import { computeCostUsd, computeCostUsdDetailed, listProviderModels, type CacheTokenBreakdown } from "../db/providerModels";

// docs/PROVIDERS_PLAN.md Phase P2 — replaces the old exported DEFAULT_PROVIDER_ID/DEFAULT_MODEL
// consts. Not exported: this is purely the last-resort fallback for a fresh install with no
// `chat` role set yet (no wizard has run to set one — see Phase P5). Once a human or a future
// wizard sets the `chat` role, this value is never read again.
const FALLBACK_CHAT_PROVIDER_ID = "together";
const FALLBACK_CHAT_MODEL = "meta-llama/Llama-3.3-70B-Instruct-Turbo";

export function getChatRoleModel(): { providerId: string; model: string } {
  const role = getModelRole("chat");
  if (role) return { providerId: role.provider_id, model: role.model_id };
  return { providerId: FALLBACK_CHAT_PROVIDER_ID, model: FALLBACK_CHAT_MODEL };
}

// docs/PROMPT_STACK_PLAN.md Phase PS0 — the old hardcoded system prompt lived here. It's now
// prompt/kernel.ts's KERNEL_PROMPT, assembled by prompt/build.ts's buildPrompt() alongside a
// tool inventory generated from the actual tool map instead of a hand-typed list. See loop.ts.

export function getModelsForProvider(providerId: string): ModelInfo[] {
  return listProviderModels(providerId);
}

// Returns pricingKnown: false (and usd: 0) rather than silently borrowing another model's price —
// the old MODEL_REGISTRY-backed version fell back to Together's Llama pricing for any unknown
// provider/model pair, which reported a real dollar figure that was simply wrong.
export function estimateCostUsd(
  providerId: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; pricingKnown: boolean } {
  return computeCostUsd(providerId, model, inputTokens, outputTokens);
}

// docs/PROMPT_STACK_PLAN.md §9.3, Phase PS1 — bills the three usage.inputTokenDetails buckets at
// their real per-provider multipliers instead of estimateCostUsd's flat input rate. loop.ts's
// main run is the only caller today: it's the one call site where cache activity is actually
// expected, so this is where the historical bug (cache reads/writes billed as full-price input)
// actually mattered.
export function estimateCostUsdDetailed(
  providerId: string,
  model: string,
  input: CacheTokenBreakdown,
  outputTokens: number,
): { usd: number; pricingKnown: boolean } {
  return computeCostUsdDetailed(providerId, model, input, outputTokens);
}
