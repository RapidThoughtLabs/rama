import type { ProviderHealthDTO, ProviderKind } from "@rama/protocol";
import { hashModelIds, touchLastSeenModels, upsertFetchedModels } from "./db/providerModels";
import { getProvider, providerRequiresKey, updateProviderHealthStatus, updateProviderModelsHash } from "./db/providers";
import { getSecret } from "./secrets";

const TIMEOUT_MS = 4000;

// Both wire shapes this probe ever sees are `{ data: [{ id, ... }] }` — OpenAI-compatible
// (Together, OpenAI, Groq, OpenRouter, and Ollama's own /v1/models) and Anthropic's /v1/models,
// which additionally carries a human `display_name` Anthropic ids don't otherwise have. Ollama
// returns the same shape as any other openai-compatible provider, just scoped to whatever the
// user has actually pulled locally — no special-casing needed for that, only for the parse shape.
function parseModelIds(kind: ProviderKind, body: unknown): { ids: string[]; labels: Record<string, string> } {
  const data = (body as { data?: unknown[] } | null)?.data;
  if (!Array.isArray(data)) return { ids: [], labels: {} };
  const ids: string[] = [];
  const labels: Record<string, string> = {};
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string") continue;
    ids.push(id);
    if (kind === "anthropic") {
      const displayName = (entry as Record<string, unknown>).display_name;
      if (typeof displayName === "string") labels[id] = displayName;
    }
  }
  return { ids, labels };
}

// A cheap, read-only reachability probe: hit the provider's model-list endpoint and time it.
// This isn't billed and doesn't touch the chat's actual model, so it's safe to poll from the
// status bar. A missing key short-circuits before any network call — that's a distinct
// "no-key" status, not "bad", so the UI can prompt for a key instead of showing an error.
//
// docs/PROVIDERS_PLAN.md Phase P0 — this used to throw the response body away. Now it's the
// engine's only source of "what can this key actually reach today" (the roster), piggybacked
// onto a poll that was already happening every 30s (see apps/desktop's ProvidersProvider) —
// zero additional network requests. The full metadata upsert only runs when the fetched id set
// changed (a real new/removed model); an unchanged set just bumps last_seen_at on every id, which
// is what lets a later read tell "still there" apart from "gone since the last successful poll".
export async function checkProviderHealth(providerId: string): Promise<ProviderHealthDTO> {
  const checkedAt = Date.now();
  const providerRow = getProvider(providerId);
  if (!providerRow) {
    return { providerId, status: "bad", latencyMs: null, error: "unknown provider", checkedAt };
  }

  const apiKey = getSecret(providerId);
  if (!apiKey && providerRequiresKey(providerId)) {
    updateProviderHealthStatus(providerId, "no-key", checkedAt);
    return { providerId, status: "no-key", latencyMs: null, error: null, checkedAt };
  }

  // Anthropic-spec base URLs are stored without /v1 (see db/providers.ts's normalizeBaseUrl); a
  // null one is the catalog's native Anthropic entry.
  const anthropicBase = (providerRow.base_url || "https://api.anthropic.com").replace(/\/+$/, "");
  const url = providerRow.kind === "anthropic" ? `${anthropicBase}/v1/models` : `${providerRow.base_url}/models`;
  // docs/PROVIDERS_PLAN.md Phase P5 — "Bearer, or a named header" is real now that a custom
  // provider can pick "header" (see configureCustomProvider); before this the auth_style/
  // auth_header columns P3 added were written but nothing ever read them for an actual request.
  let headers: Record<string, string>;
  if (providerRow.kind === "anthropic") {
    headers = { "x-api-key": apiKey ?? "", "anthropic-version": "2023-06-01" };
  } else if (providerRow.auth_style === "header" && providerRow.auth_header) {
    headers = { [providerRow.auth_header]: apiKey ?? "" };
  } else {
    headers = { Authorization: `Bearer ${apiKey ?? ""}` };
  }
  try {
    const extraHeaders = JSON.parse(providerRow.extra_headers_json || "{}") as Record<string, string>;
    headers = { ...headers, ...extraHeaders };
  } catch {
    // malformed extra_headers_json shouldn't block the probe — same tolerance as catalog.ts
    // gives a bad ~/.rama/catalog.json.
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const latencyMs = Date.now() - started;
    // Anthropic-compatible gateways often implement /v1/messages and nothing else. A 404 on the
    // model list still proves the host answered, and without this the provider would be hidden
    // from the model menu forever (unreachable providers are hidden, PROVIDERS_PLAN P1). Its
    // models are added by id in Settings › Models instead.
    if (res.status === 404 && providerRow.kind === "anthropic") {
      updateProviderHealthStatus(providerId, "ok", checkedAt);
      return { providerId, status: "ok", latencyMs, error: null, checkedAt };
    }
    if (!res.ok) {
      updateProviderHealthStatus(providerId, "bad", checkedAt);
      return { providerId, status: "bad", latencyMs, error: `HTTP ${res.status}`, checkedAt };
    }

    try {
      const body = await res.json();
      const { ids, labels } = parseModelIds(providerRow.kind, body);
      const hash = hashModelIds(ids);
      if (hash !== providerRow.models_hash) {
        upsertFetchedModels(providerId, ids, labels, checkedAt);
        updateProviderModelsHash(providerId, hash, checkedAt);
      } else {
        touchLastSeenModels(providerId, ids, checkedAt);
      }
    } catch {
      // A 200 with an unparseable/unexpected body still means "reachable" — the roster just
      // doesn't get updated this round. Don't fail the health check over it.
    }

    updateProviderHealthStatus(providerId, "ok", checkedAt);
    return { providerId, status: "ok", latencyMs, error: null, checkedAt };
  } catch (err) {
    const message = err instanceof Error ? (err.name === "AbortError" ? "timed out" : err.message) : String(err);
    updateProviderHealthStatus(providerId, "bad", checkedAt);
    return { providerId, status: "bad", latencyMs: Date.now() - started, error: message, checkedAt };
  } finally {
    clearTimeout(timeout);
  }
}
