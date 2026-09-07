// docs/PROVIDERS_PLAN.md Phase P6 — "OpenRouter as a metadata oracle." OpenRouter's /models needs
// no key and returns pricing, context length and capability hints for hundreds of models across
// every vendor. This module only ever *fills gaps* on provider_models rows a real provider fetch
// already created (guardrail 1) — see db/providerModels.ts's enrichModelFromOracle for where that
// is actually enforced at the SQL layer. Deliberately dependency-light (only db/providerModels and
// agent/catalog, never ./db/index directly) so this file can't introduce an import cycle no matter
// what ends up calling it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCatalogModel } from "./agent/catalog";
import { enrichModelFromOracle, listEnrichmentCandidates, type OracleEnrichmentPatch } from "./db/providerModels";

// Duplicated rather than imported from db/index.ts — same reasoning as agent/catalog.ts's own
// RAMA_HOME constant: this file has no other reason to depend on the db module graph, and one
// duplicated path-join is cheaper than a fragile import-order dependency.
const RAMA_HOME = join(homedir(), ".rama");
const CACHE_PATH = join(RAMA_HOME, "catalog-cache.json");
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterRawModel {
  id: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  architecture?: { input_modalities?: string[] };
  supported_parameters?: string[];
}

interface OracleCache {
  fetchedAt: number;
  models: OpenRouterRawModel[];
}

function loadCache(): OracleCache | null {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(CACHE_PATH, "utf8"));
    if (parsed && typeof parsed.fetchedAt === "number" && Array.isArray(parsed.models)) return parsed as OracleCache;
  } catch {
    // a corrupt cache file is just treated as "no cache" — see fetchOpenRouterModels's caller
  }
  return null;
}

function saveCache(cache: OracleCache): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch (err) {
    console.error(`[openrouter-oracle] failed to write ${CACHE_PATH}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fetchOpenRouterModels(): Promise<OpenRouterRawModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL);
  if (!res.ok) throw new Error(`GET ${OPENROUTER_MODELS_URL}: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) throw new Error(`GET ${OPENROUTER_MODELS_URL}: unexpected response shape`);
  return body.data as OpenRouterRawModel[];
}

// "supported_parameters" omitting "tools"/"reasoning" is treated as a real negative, not
// "unknown" — OpenRouter's list is meant to be exhaustive per model, unlike a provider's own
// /models response which carries no capability info at all. Pricing is the one field kept
// nullable on a miss: a model OpenRouter doesn't price at all must not read as "free".
function toEnrichmentPatch(model: OpenRouterRawModel): OracleEnrichmentPatch {
  const params = Array.isArray(model.supported_parameters) ? model.supported_parameters : [];
  const inputModalities = model.architecture?.input_modalities ?? [];
  const promptPrice = model.pricing ? Number(model.pricing.prompt) : NaN;
  const completionPrice = model.pricing ? Number(model.pricing.completion) : NaN;
  const havePrice = Number.isFinite(promptPrice) && Number.isFinite(completionPrice) && promptPrice >= 0 && completionPrice >= 0;
  return {
    supportsTools: params.includes("tools") ? 1 : 0,
    supportsThinking: params.includes("reasoning") || params.includes("include_reasoning") ? 1 : 0,
    supportsVision: inputModalities.includes("image") ? 1 : 0,
    contextWindow: typeof model.context_length === "number" && model.context_length > 0 ? model.context_length : null,
    inputPerMillion: havePrice ? promptPrice * 1_000_000 : null,
    outputPerMillion: havePrice ? completionPrice * 1_000_000 : null,
  };
}

function normalizeSuffix(id: string): string {
  const lower = id.toLowerCase();
  const slash = lower.lastIndexOf("/");
  return slash === -1 ? lower : lower.slice(slash + 1);
}

export interface EnrichResult {
  ran: boolean;
  matched: number;
}

// docs/PROVIDERS_PLAN.md Phase P6 mechanics — "one unauthenticated GET, at most weekly, cached ...
// never on the boot path, fails silent, skipped entirely when there is nothing to enrich." The
// settings toggle gating whether this is ever called at all lives with the caller (server.ts's
// route), not here, so this function does exactly one thing: given permission to run, run safely.
export async function enrichFromOpenRouter(opts: { force?: boolean } = {}): Promise<EnrichResult> {
  const candidates = listEnrichmentCandidates();
  if (candidates.length === 0) return { ran: false, matched: 0 };

  const cache = loadCache();
  const stale = !cache || Date.now() - cache.fetchedAt > WEEK_MS;
  let models: OpenRouterRawModel[];
  if (opts.force || stale) {
    try {
      models = await fetchOpenRouterModels();
      saveCache({ fetchedAt: Date.now(), models });
    } catch (err) {
      console.error(`[openrouter-oracle] fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!cache) return { ran: false, matched: 0 };
      models = cache.models;
    }
  } else {
    models = cache.models;
  }

  // guardrail 2 — "exact match or nothing." A curated openrouterId is matched by full id (no
  // ambiguity possible, it was hand-picked). A row with no curated mapping falls back to matching
  // its own id's suffix (post-vendor-prefix) against OpenRouter's, but only when that suffix is
  // unique across OpenRouter's whole list — an ambiguous suffix means "don't guess", not "pick one".
  const byFullId = new Map<string, OpenRouterRawModel>();
  const bySuffix = new Map<string, OpenRouterRawModel | null>();
  for (const model of models) {
    if (typeof model.id !== "string" || !model.id) continue;
    byFullId.set(model.id.toLowerCase(), model);
    const suffix = normalizeSuffix(model.id);
    bySuffix.set(suffix, bySuffix.has(suffix) ? null : model);
  }

  let matched = 0;
  for (const { provider_id: providerId, model_id: modelId } of candidates) {
    const openrouterId = getCatalogModel(providerId, modelId)?.openrouterId;
    const orModel = openrouterId ? byFullId.get(openrouterId.toLowerCase()) : (bySuffix.get(normalizeSuffix(modelId)) ?? undefined);
    if (!orModel) continue;
    if (enrichModelFromOracle(providerId, modelId, toEnrichmentPatch(orModel))) matched++;
  }
  return { ran: true, matched };
}
