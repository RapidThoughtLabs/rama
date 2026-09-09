// docs/PROVIDERS_PLAN.md Phase P0 — the provider_models DAO. This module only ever depends on
// ./index (raw db handle) and ../agent/catalog — never on ./providers or ../agent/config — so
// that config.ts (which re-exports getModelsForProvider/estimateCostUsd from here) and
// providers.ts (which imports config.ts) can both sit downstream of this file without a cycle.
// Orchestration (deciding *when* to call these against a live /models response) lives in
// providerHealth.ts, which already has both a ProviderRow and this module in scope.
import { createHash } from "node:crypto";
import type { ModelInfo, ModelPricing, ModelStatus, ModelTier } from "@rama/protocol";
import { getCachePolicy, getCatalog, getCatalogProvider } from "../agent/catalog";
import { db } from "./index";

export interface ProviderModelRow {
  provider_id: string;
  model_id: string;
  label: string | null;
  enabled: number;
  pinned: number;
  in_catalog: number;
  fetched_at: number | null;
  added_manually: number;
  supports_tools: number | null;
  supports_thinking: number | null;
  supports_vision: number | null;
  context_window: number | null;
  input_per_million: number | null;
  output_per_million: number | null;
  price_source: string | null;
  tier: string | null;
  first_seen_at: number;
  last_seen_at: number;
  deprecated: number;
  superseded_by: string | null;
  last_error: string | null;
  last_error_at: number | null;
  last_error_kind: string | null;
}

export function hashModelIds(ids: string[]): string {
  return createHash("sha1").update([...ids].sort().join(",")).digest("hex");
}

// Rehydrates provider_models from catalog.json on every boot — "catalog decides meaning". Only
// meaning-fields (label, tier, capability flags, pricing, deprecation) are in the UPDATE branch,
// so an existing row's existence/fetch state (first_seen_at, last_seen_at, fetched_at) and user
// state (enabled, pinned, added_manually) are never touched here, satisfying the non-interference
// invariant. price_source only ever regresses catalog -> never overwrites a 'user' override.
export function refreshModelCatalog(): void {
  const now = Date.now();
  const catalog = getCatalog();
  const stmt = db.prepare(
    `INSERT INTO provider_models (
       provider_id, model_id, label, in_catalog, first_seen_at, last_seen_at,
       supports_tools, supports_thinking, supports_vision, context_window,
       input_per_million, output_per_million, price_source, tier, deprecated, superseded_by
     ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog', ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       label = excluded.label,
       in_catalog = 1,
       supports_tools = excluded.supports_tools,
       supports_thinking = excluded.supports_thinking,
       supports_vision = excluded.supports_vision,
       context_window = excluded.context_window,
       input_per_million = excluded.input_per_million,
       output_per_million = excluded.output_per_million,
       price_source = CASE WHEN provider_models.price_source = 'user' THEN 'user' ELSE 'catalog' END,
       tier = excluded.tier,
       deprecated = excluded.deprecated,
       superseded_by = excluded.superseded_by`,
  );
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      stmt.run(
        provider.id,
        model.id,
        model.label,
        now,
        now,
        model.supportsTools ? 1 : 0,
        model.supportsThinking ? 1 : 0,
        model.supportsVision ? 1 : 0,
        model.contextWindow,
        model.inputPerMillion,
        model.outputPerMillion,
        model.tier,
        model.deprecated ? 1 : 0,
        model.supersededBy,
      );
    }
  }
}

// Full upsert — only reached when the fetched id set actually changed (new/removed model), so a
// brand-new, not-in-catalog model gets its only source of a label here; an existing (likely
// catalog-seeded) row keeps its label/in_catalog untouched since those columns aren't in the SET
// clause. fetched_at/last_seen_at mark it as confirmed-present in this poll.
export function upsertFetchedModels(providerId: string, ids: string[], labels: Record<string, string>, now: number): void {
  const stmt = db.prepare(
    `INSERT INTO provider_models (provider_id, model_id, label, in_catalog, fetched_at, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 0, ?, ?, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       fetched_at = excluded.fetched_at,
       last_seen_at = excluded.last_seen_at`,
  );
  for (const id of ids) {
    stmt.run(providerId, id, labels[id] ?? id, now, now, now);
  }
}

// Cheap branch — the fetched id set is unchanged since the last poll, so this just proves every
// currently-offered model is still there without touching any metadata column.
export function touchLastSeenModels(providerId: string, ids: string[], now: number): void {
  if (ids.length === 0) return;
  const stmt = db.prepare(`UPDATE provider_models SET last_seen_at = ? WHERE provider_id = ? AND model_id = ?`);
  const tx = db.transaction((idList: string[]) => {
    for (const id of idList) stmt.run(now, providerId, id);
  });
  tx(ids);
}

export type ModelErrorKind = "durable" | "transient";

// docs/PROVIDERS_PLAN.md Phase P1 — per-model health a provider-level probe can't give you: a
// provider can be `ok` while one model 403s (tier-gated orgs, rate tiers, no-credit models). Only
// `durable` errors affect the derived status (see deriveStatus below); `transient` ones are
// recorded for display only so a rate limit can never hide a model the user relies on. A no-op if
// the row doesn't exist yet (an error can only be attributed to a model Rama already knows about).
export function recordModelError(providerId: string, modelId: string, error: string, kind: ModelErrorKind, now: number): void {
  db.query(
    "UPDATE provider_models SET last_error = ?, last_error_at = ?, last_error_kind = ? WHERE provider_id = ? AND model_id = ?",
  ).run(error, now, kind, providerId, modelId);
}

// A `durable` mark is otherwise permanent — nothing else ever un-sets last_error_kind. Called on
// a turn that actually completes on this model, so a model that starts working again (tier
// upgraded, credit added) comes back out of `erroring` instead of staying hidden forever.
export function clearModelError(providerId: string, modelId: string): void {
  db.query(
    "UPDATE provider_models SET last_error = NULL, last_error_at = NULL, last_error_kind = NULL WHERE provider_id = ? AND model_id = ? AND last_error_kind IS NOT NULL",
  ).run(providerId, modelId);
}

function deriveStatus(row: ProviderModelRow, lastHealthAt: number | null): ModelStatus {
  if (row.last_error_kind === "durable") return "erroring";
  if (row.fetched_at == null) return "unverified";
  if (lastHealthAt != null && row.last_seen_at < lastHealthAt) return "missing";
  return "available";
}

function toModelInfo(row: ProviderModelRow, lastHealthAt: number | null): ModelInfo {
  const pricing: ModelPricing | null =
    row.input_per_million != null && row.output_per_million != null && row.price_source
      ? { inputPerMillion: row.input_per_million, outputPerMillion: row.output_per_million, source: row.price_source as ModelPricing["source"] }
      : null;
  return {
    id: row.model_id,
    label: row.label ?? row.model_id,
    supportsTools: !!row.supports_tools,
    supportsThinking: !!row.supports_thinking,
    supportsVision: !!row.supports_vision,
    contextWindow: row.context_window ?? 0,
    status: deriveStatus(row, lastHealthAt),
    tier: (row.tier as ModelTier | null) ?? null,
    pricing,
    deprecated: !!row.deprecated,
    supersededBy: row.superseded_by ?? null,
    // docs/PROVIDERS_PLAN.md Phase P4 — the providers pane's tick state, "new since you last
    // looked", the catalog-known-only default filter, and the erroring chip's error text.
    enabled: !!row.enabled,
    pinned: !!row.pinned,
    inCatalog: !!row.in_catalog,
    addedManually: !!row.added_manually,
    firstSeenAt: row.first_seen_at,
    lastError: row.last_error_kind === "durable" ? row.last_error : null,
  };
}

// The one function the composer picker and the providers pane both read through. `enabled` was
// left unfiltered through Phase P0-P3 (nothing had ever set the column), which is what P1's
// ModelPicker had to work around with a `status`-based interim filter — see that file's comment
// on the deviation this phase closes out.
export function listProviderModels(providerId: string): ModelInfo[] {
  const providerHealth = db
    .query<{ last_health_at: number | null }, [string]>("SELECT last_health_at FROM providers WHERE id = ?")
    .get(providerId);
  if (!providerHealth) return [];
  const rows = db
    .query<ProviderModelRow, [string]>("SELECT * FROM provider_models WHERE provider_id = ? ORDER BY in_catalog DESC, label ASC")
    .all(providerId);
  return rows.map((row) => toModelInfo(row, providerHealth.last_health_at));
}

export function computeCostUsd(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): { usd: number; pricingKnown: boolean } {
  const row = db
    .query<Pick<ProviderModelRow, "input_per_million" | "output_per_million">, [string, string]>(
      "SELECT input_per_million, output_per_million FROM provider_models WHERE provider_id = ? AND model_id = ?",
    )
    .get(providerId, modelId);
  if (!row || row.input_per_million == null || row.output_per_million == null) {
    return { usd: 0, pricingKnown: false };
  }
  const usd = (inputTokens / 1_000_000) * row.input_per_million + (outputTokens / 1_000_000) * row.output_per_million;
  return { usd, pricingKnown: true };
}

export interface CacheTokenBreakdown {
  noCacheTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// docs/PROMPT_STACK_PLAN.md §9.3, Phase PS1 — computeCostUsd's cache-aware sibling. The bug this
// replaces at the one call site that matters (loop.ts's main run): usage.inputTokens includes
// cache reads and writes, and billing all of it at the full input rate means the moment caching
// actually works, the cost line shows no savings and overcharges on top. Each bucket gets its own
// multiplier from the catalog (1 = no known discount, never a guessed one — see catalog.ts's
// getCachePolicy).
export function computeCostUsdDetailed(
  providerId: string,
  modelId: string,
  input: CacheTokenBreakdown,
  outputTokens: number,
): { usd: number; pricingKnown: boolean } {
  const row = db
    .query<Pick<ProviderModelRow, "input_per_million" | "output_per_million">, [string, string]>(
      "SELECT input_per_million, output_per_million FROM provider_models WHERE provider_id = ? AND model_id = ?",
    )
    .get(providerId, modelId);
  if (!row || row.input_per_million == null || row.output_per_million == null) {
    return { usd: 0, pricingKnown: false };
  }
  const policy = getCachePolicy(providerId, modelId);
  const inputUsd =
    (input.noCacheTokens / 1_000_000) * row.input_per_million +
    (input.cacheReadTokens / 1_000_000) * row.input_per_million * policy.readMultiplier +
    (input.cacheWriteTokens / 1_000_000) * row.input_per_million * policy.writeMultiplier;
  const usd = inputUsd + (outputTokens / 1_000_000) * row.output_per_million;
  return { usd, pricingKnown: true };
}

// docs/PROVIDERS_PLAN.md Phase P4 fast-add — "defaultEnabled models silently ticked" on configure.
// Also reused by Phase P3's migration to give a chat-referenced legacy provider a starting
// shortlist, since nothing ever set `enabled` before this phase. A no-op for ids the catalog
// hint names that this provider hasn't actually got a row for yet (nothing to enable).
export function enableDefaultModels(providerId: string): void {
  const catalogProvider = getCatalogProvider(providerId);
  if (!catalogProvider) return;
  const defaultIds = catalogProvider.models.filter((m) => m.defaultEnabled).map((m) => m.id);
  if (defaultIds.length === 0) return;
  const stmt = db.prepare("UPDATE provider_models SET enabled = 1 WHERE provider_id = ? AND model_id = ?");
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(providerId, id);
  });
  tx(defaultIds);
}

export function setModelEnabled(providerId: string, modelId: string, enabled: boolean): void {
  db.query("UPDATE provider_models SET enabled = ? WHERE provider_id = ? AND model_id = ?").run(
    enabled ? 1 : 0,
    providerId,
    modelId,
  );
}

// "Rows carry `+ add model manually` ... for fine-tunes and private deployments" — a model id
// neither the catalog nor a fetch has ever seen. Enabled by default: the only reason to add one
// by hand is to use it right away. A no-op if the id already exists (catalog-known, previously
// fetched, or already added) rather than clobbering whatever state that row already has.
export function addManualModel(providerId: string, modelId: string, label: string | undefined, now: number): void {
  db.query(
    `INSERT INTO provider_models (provider_id, model_id, label, enabled, added_manually, in_catalog, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, 1, 1, 0, ?, ?)
     ON CONFLICT(provider_id, model_id) DO NOTHING`,
  ).run(providerId, modelId, label ?? modelId, now, now);
}

// "Missing models stay in place, greyed, `no longer offered — remove?`" — this is that removal.
// Only meaningful for a row with nothing else worth keeping (missing, or a manual entry the user
// no longer wants); a catalog-known row would just come back on the next refreshModelCatalog(),
// so removal there is really "disable", handled by setModelEnabled.
export function deleteProviderModel(providerId: string, modelId: string): boolean {
  const result = db.query("DELETE FROM provider_models WHERE provider_id = ? AND model_id = ?").run(providerId, modelId);
  return result.changes > 0;
}

export function deleteAllModelsForProvider(providerId: string): void {
  db.query("DELETE FROM provider_models WHERE provider_id = ?").run(providerId);
}

// "where `superseded_by` is set, `→ Claude Sonnet 5 available` with a one-click switch" — enables
// the newer model and turns the superseded one off, rather than leaving both on and doubling the
// picker for what the user experiences as one decision.
export function switchSupersededModel(providerId: string, fromModelId: string, toModelId: string): void {
  setModelEnabled(providerId, toModelId, true);
  setModelEnabled(providerId, fromModelId, false);
}

// docs/PROVIDERS_PLAN.md Phase P6 — every row `enrichFromOpenRouter` (engine/src/openrouterOracle.ts)
// might have something to add to. Kept here rather than a raw query in that file so all
// provider_models access stays in this DAO; the oracle only ever sees provider_id/model_id pairs,
// never row internals, which is what keeps guardrail 1 ("it enriches, it never creates") honest —
// there is no function here that lets it insert a row that doesn't already exist.
export function listEnrichmentCandidates(): { provider_id: string; model_id: string }[] {
  return db.query<{ provider_id: string; model_id: string }, []>("SELECT provider_id, model_id FROM provider_models").all();
}

export interface OracleEnrichmentPatch {
  supportsTools: 0 | 1;
  supportsThinking: 0 | 1;
  supportsVision: 0 | 1;
  contextWindow: number | null;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
}

// docs/PROVIDERS_PLAN.md Phase P6 guardrails, enforced here rather than trusted to the caller:
// (1) "enriches, never creates" — the WHERE below can only ever match a row that already exists,
// there is no INSERT branch. (2) capability flags and context window only fill a column that is
// currently NULL (`row.x ?? patch.x`), so a real catalog-sourced 0/false is never flipped by an
// OpenRouter guess. (3) "mark the provenance, never overwrite catalog or user" — pricing only
// moves when price_source is NULL or already 'openrouter', and only when the patch actually has
// both numbers; a model OpenRouter no longer prices doesn't erase a price this function itself
// wrote last week.
export function enrichModelFromOracle(providerId: string, modelId: string, patch: OracleEnrichmentPatch): boolean {
  const row = db
    .query<Pick<ProviderModelRow, "supports_tools" | "supports_thinking" | "supports_vision" | "context_window" | "price_source">, [string, string]>(
      "SELECT supports_tools, supports_thinking, supports_vision, context_window, price_source FROM provider_models WHERE provider_id = ? AND model_id = ?",
    )
    .get(providerId, modelId);
  if (!row) return false;

  const nextSupportsTools = row.supports_tools ?? patch.supportsTools;
  const nextSupportsThinking = row.supports_thinking ?? patch.supportsThinking;
  const nextSupportsVision = row.supports_vision ?? patch.supportsVision;
  const nextContextWindow = row.context_window ?? patch.contextWindow;
  const canPrice = row.price_source === null || row.price_source === "openrouter";
  const havePrice = patch.inputPerMillion != null && patch.outputPerMillion != null;

  if (canPrice && havePrice) {
    db.query(
      `UPDATE provider_models SET
         supports_tools = ?, supports_thinking = ?, supports_vision = ?, context_window = ?,
         input_per_million = ?, output_per_million = ?, price_source = 'openrouter'
       WHERE provider_id = ? AND model_id = ?`,
    ).run(nextSupportsTools, nextSupportsThinking, nextSupportsVision, nextContextWindow, patch.inputPerMillion, patch.outputPerMillion, providerId, modelId);
  } else {
    db.query(
      `UPDATE provider_models SET supports_tools = ?, supports_thinking = ?, supports_vision = ?, context_window = ?
       WHERE provider_id = ? AND model_id = ?`,
    ).run(nextSupportsTools, nextSupportsThinking, nextSupportsVision, nextContextWindow, providerId, modelId);
  }
  return true;
}
