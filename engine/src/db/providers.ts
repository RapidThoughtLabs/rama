import type { ProviderDTO, ProviderKind } from "@rama/protocol";
import { getCatalog, getCatalogProvider } from "../agent/catalog";
import { getModelsForProvider } from "../agent/config";
import { db } from "./index";
import { deleteAllModelsForProvider, enableDefaultModels, setModelEnabled } from "./providerModels";
import { getSetting, setSetting } from "./settings";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  base_url: string | null;
  label: string | null;
  created_at: number;
  // docs/PROVIDERS_PLAN.md Phase P0 — roster state piggybacked on the health probe.
  models_hash: string | null;
  models_fetched_at: number | null;
  last_health_status: string | null;
  last_health_at: number | null;
  // docs/PROVIDERS_PLAN.md Phase P3 — copied from the catalog at configure time, not re-derived
  // from a hardcoded id map the way the old (now-removed) REQUIRES_KEY did, which silently
  // answered `true` for any id it had never heard of.
  is_custom: number;
  enabled: number;
  requires_key: number;
  auth_style: "bearer" | "header";
  auth_header: string | null;
  extra_headers_json: string;
}

export function getProvider(id: string): ProviderRow | null {
  return db.query<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?").get(id);
}

// Was a hardcoded id -> bool map before Phase P3 — silently answered `true` for any id it had
// never heard of, which is wrong for a keyless custom endpoint (LM Studio, vLLM). Now it's just
// the row's own column; a provider that was never configured has no opinion, so default to `true`
// (the safer failure — prompting for a key nobody needs beats sending no auth to one that does).
export function providerRequiresKey(id: string): boolean {
  return getProvider(id)?.requires_key !== 0;
}

// Written from providerHealth.ts's 30s probe. Kept as plain UPDATEs (not upserts) — by the time
// either of these could run, the provider row was already created by configureProvider().
export function updateProviderModelsHash(id: string, hash: string, fetchedAt: number): void {
  db.query("UPDATE providers SET models_hash = ?, models_fetched_at = ? WHERE id = ?").run(hash, fetchedAt, id);
}

export function updateProviderHealthStatus(id: string, status: string, checkedAt: number): void {
  db.query("UPDATE providers SET last_health_status = ?, last_health_at = ? WHERE id = ?").run(status, checkedAt, id);
}

function toDTO(row: ProviderRow): ProviderDTO {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label ?? row.id,
    baseUrl: row.base_url,
    requiresKey: !!row.requires_key,
    isCustom: !!row.is_custom,
    enabled: !!row.enabled,
    models: getModelsForProvider(row.id),
    // docs/PROVIDERS_PLAN.md Phase P1 guard 1 — lets the composer picker seed its boot state from
    // "was fine yesterday" instead of blind `checking`, so a cold start isn't empty for a second.
    lastHealthStatus: (row.last_health_status as ProviderDTO["lastHealthStatus"]) ?? null,
    lastHealthAt: row.last_health_at,
  };
}

export function listProviders(): ProviderDTO[] {
  const rows = db.query<ProviderRow, []>("SELECT * FROM providers ORDER BY created_at ASC").all();
  return rows.map(toDTO);
}

export function getProviderDTO(id: string): ProviderDTO | null {
  const row = getProvider(id);
  return row ? toDTO(row) : null;
}

// docs/PROVIDERS_PLAN.md Phase P4 fast-add / the legacy-key resurrection in
// migrateLegacyProviderSeeds — the one place a `providers` row gets created. Only ever from a
// catalog entry (a wholly custom, catalog-less provider is Phase P5); idempotent, so it's safe to
// call on every "configure this provider" action without checking existence first.
export function configureProvider(id: string): { row: ProviderRow; created: boolean } | null {
  const existing = getProvider(id);
  if (existing) return { row: existing, created: false };

  const catalogProvider = getCatalogProvider(id);
  if (!catalogProvider) return null;

  const now = Date.now();
  db.query(
    `INSERT INTO providers (id, kind, base_url, label, created_at, is_custom, enabled, requires_key, auth_style, auth_header, extra_headers_json)
     VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?, ?)`,
  ).run(
    id,
    catalogProvider.kind,
    catalogProvider.baseUrl,
    catalogProvider.label,
    now,
    catalogProvider.requiresKey ? 1 : 0,
    catalogProvider.authStyle,
    catalogProvider.authHeader,
    JSON.stringify(catalogProvider.extraHeaders ?? {}),
  );
  return { row: getProvider(id)!, created: true };
}

// Settings › Providers takes whatever the user pastes. An Anthropic-spec URL is stored without its
// /v1 (AnthropicStreamClient and the health probe both append /v1/...), and an OpenAI-spec URL
// without a pasted /chat/completions, so the two most common paste mistakes still connect.
export function normalizeBaseUrl(kind: ProviderKind, url: string): string {
  let out = url.trim().replace(/\/+$/, "");
  if (kind === "anthropic") out = out.replace(/\/v1(\/messages)?$/i, "");
  else out = out.replace(/\/chat\/completions$/i, "");
  return out;
}

const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

export function updateProviderConfig(id: string, patch: { baseUrl?: string; label?: string; requiresKey?: boolean }): ProviderDTO | null {
  const existing = getProvider(id);
  if (!existing) return null;
  db.query("UPDATE providers SET base_url = ?, label = ?, requires_key = ? WHERE id = ?").run(
    patch.baseUrl != null ? normalizeBaseUrl(existing.kind, patch.baseUrl) : existing.base_url,
    patch.label ?? existing.label,
    patch.requiresKey != null ? (patch.requiresKey ? 1 : 0) : existing.requires_key,
    id,
  );
  return getProviderDTO(id);
}

// docs/PROVIDERS_PLAN.md Phase P5 — turns a display label into a stable id the same way a catalog
// entry already has one, so a custom provider looks identical to a catalog one everywhere else in
// the schema (chats.provider_id, provider_models.provider_id, model_roles.provider_id). Falls back
// to "custom" for a label with no latin/digit characters at all (e.g. all-emoji), and disambiguates
// a collision against an existing row or a catalog id by appending -2, -3, ... rather than failing
// the wizard over a name someone already used.
function slugifyProviderId(label: string): string {
  const base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "custom";
}

function uniqueProviderId(label: string): string {
  const base = slugifyProviderId(label);
  if (!getProvider(base) && !getCatalogProvider(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!getProvider(candidate) && !getCatalogProvider(candidate)) return candidate;
  }
}

export interface CustomProviderInput {
  kind: ProviderKind;
  label: string;
  baseUrl: string;
  requiresKey: boolean;
  authStyle: "bearer" | "header";
  authHeader: string | null;
}

// The catalog entry an endpoint *is*, when it is one: same wire format, same base URL. Settings no
// longer offers catalog tiles, so a user who adds "https://api.together.xyz/v1" by hand has to land
// on the same id the tile used to create — cache policy, the utility-model hint, catalog pricing
// and the OpenRouter id map are all keyed by it. Only while that id is free: a second Together
// account gets a slug id and no catalog meaning, which is the old custom-provider behaviour.
export function catalogIdForEndpoint(kind: ProviderKind, baseUrl: string, isTaken: (id: string) => boolean = (id) => !!getProvider(id)): string | null {
  const want = normalizeBaseUrl(kind, baseUrl).toLowerCase();
  for (const p of getCatalog().providers) {
    if (p.kind !== kind) continue;
    const have = normalizeBaseUrl(kind, p.baseUrl ?? (kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : "")).toLowerCase();
    if (have && have === want && !isTaken(p.id)) return p.id;
  }
  return null;
}

// docs/PROVIDERS_PLAN.md Phase P5, reworked: Settings › Providers now creates every provider here —
// the user picks the wire format (OpenAI-compatible or Anthropic) and a base URL, nothing else is
// predefined. `is_custom` stays 1 unless the endpoint resolved to a catalog id above. An Anthropic
// endpoint always authenticates with x-api-key (AnthropicStreamClient sets it), so auth style is
// only meaningful for the OpenAI-compatible adapter.
export function configureCustomProvider(input: CustomProviderInput): { row: ProviderRow; catalogMatch: boolean } {
  const baseUrl = normalizeBaseUrl(input.kind, input.baseUrl);
  const catalogId = catalogIdForEndpoint(input.kind, baseUrl);
  const id = catalogId ?? uniqueProviderId(input.label);
  const anthropic = input.kind === "anthropic";
  const now = Date.now();
  db.query(
    `INSERT INTO providers (id, kind, base_url, label, created_at, is_custom, enabled, requires_key, auth_style, auth_header, extra_headers_json)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '{}')`,
  ).run(
    id,
    input.kind,
    baseUrl,
    input.label,
    now,
    catalogId ? 0 : 1,
    input.requiresKey ? 1 : 0,
    anthropic ? "bearer" : input.authStyle,
    anthropic ? null : input.authHeader,
  );
  return { row: getProvider(id)!, catalogMatch: !!catalogId };
}

// docs/PROVIDERS_PLAN.md Phase P3 — "removal ... cascading provider_models and clearing any
// model_roles row that pointed at it." Chats pointing at this provider are deliberately left
// alone (see the phase's own note on why auto-migrating a chat's model is worse than a dead end).
export function deleteProviderRow(id: string): boolean {
  const existing = getProvider(id);
  if (!existing) return false;
  deleteAllModelsForProvider(id);
  db.query("DELETE FROM model_roles WHERE provider_id = ?").run(id);
  db.query("DELETE FROM providers WHERE id = ?").run(id);
  return true;
}

// docs/PROVIDERS_PLAN.md Phase P3 — the destructive migration, run once. Before this phase every
// install had all six seed rows regardless of use; a provider row now means "configured", so a
// seed row earns to stay only if something depends on it.
//
// The engine has no access to the OS keychain (it lives in Rust, pushed into memory by the
// webview on boot — see ../secrets.ts) so "has a keychain entry" can't be checked from here. This
// half only applies the other clause of the OR — "any chat references it" — which is fully
// decidable from this DB alone. The keychain half is applied afterward, from the frontend (see
// apps/desktop's ProvidersProvider), by resurrecting via configureProvider() any legacy id this
// pass removed that turns out to have a saved key; net result matches the plan's single rule
// regardless of which half fires first.
const LEGACY_SEED_PROVIDER_IDS = ["together", "openai", "groq", "openrouter", "ollama", "anthropic"];
const MIGRATIONS_SETTING_KEY = "_migrations";

interface MigrationsState {
  p3SeedCleanup?: boolean;
}

export function migrateLegacyProviderSeeds(): void {
  const state = getSetting<MigrationsState>(MIGRATIONS_SETTING_KEY) ?? {};
  if (state.p3SeedCleanup) return;

  for (const id of LEGACY_SEED_PROVIDER_IDS) {
    if (!getProvider(id)) continue;
    const referenced = db.query("SELECT 1 FROM chats WHERE provider_id = ? LIMIT 1").get(id);
    if (referenced) {
      // Kept for continuity — but nothing has ever set provider_models.enabled before Phase P4,
      // so without this a chat-referenced provider would survive with zero enabled models.
      enableDefaultModels(id);
      // The chat's own model may not be in the catalog's default set (a frontier model the user
      // picked by hand pre-P4) — without this it would keep working (guard 3 exempts the current
      // selection) but vanish from every OTHER surface that now filters on `enabled`.
      const usedModels = db
        .query<{ model: string }, [string]>("SELECT DISTINCT model FROM chats WHERE provider_id = ?")
        .all(id);
      for (const { model } of usedModels) setModelEnabled(id, model, true);
      continue;
    }
    deleteProviderRow(id);
  }

  setSetting(MIGRATIONS_SETTING_KEY, { ...state, p3SeedCleanup: true });
}
