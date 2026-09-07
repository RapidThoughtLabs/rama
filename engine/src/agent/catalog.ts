// docs/PROVIDERS_PLAN.md Phase P0 — "catalog decides meaning": what Rama knows about a model
// (pricing, context window, capability flags, tier) independent of whether any key can reach it
// today. Two sources, same "bundled + override, user wins on collision" shape as
// engine/src/themes/store.ts, but merged per provider/model rather than whole-file — a user
// tweaking one price or pinning one model shouldn't have to re-author all six providers.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Deliberately not imported from db/index.ts: db/index.ts -> db/providers.ts -> this file's
// caller (agent/config.ts) -> db/providerModels.ts -> here would close a circular import back to
// db/index.ts, and RAMA_HOME is read at module-eval time below (not inside a function), so the
// cycle would hit it mid-TDZ. One duplicated path-join is cheaper than that fragility.
const RAMA_HOME = join(homedir(), ".rama");

export type CatalogTier = "frontier" | "workhorse" | "small";
export type CatalogAuthStyle = "bearer" | "header";

export interface CatalogModel {
  id: string;
  label: string;
  tier: CatalogTier;
  supportsTools: boolean;
  supportsThinking: boolean;
  supportsVision: boolean;
  contextWindow: number;
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  defaultEnabled: boolean;
  openrouterId: string | null;
  deprecated: boolean;
  supersededBy: string | null;
}

export interface CatalogProvider {
  id: string;
  label: string;
  kind: "openai-compatible" | "anthropic";
  baseUrl: string | null;
  requiresKey: boolean;
  docsUrl: string | null;
  authStyle: CatalogAuthStyle;
  authHeader: string | null;
  extraHeaders: Record<string, string>;
  utilityModel: string | null;
  models: CatalogModel[];
}

export interface CatalogFile {
  providers: CatalogProvider[];
}

const BUNDLED_CATALOG_PATH = join(import.meta.dir, "catalog.json");
const USER_CATALOG_PATH = join(RAMA_HOME, "catalog.json");

function loadBundledCatalog(): CatalogFile {
  return JSON.parse(readFileSync(BUNDLED_CATALOG_PATH, "utf8")) as CatalogFile;
}

// Overlay merge: a provider present in both sides gets its top-level fields replaced by the
// override (only when the override actually sets them) and its models merged by id — an
// override model replaces the bundled one field-for-field, an override-only model id is added,
// and a bundled model the override doesn't mention survives untouched. A wholly new provider id
// in the override is accepted as-is, which is how a fully custom, catalog-less provider gets a
// real catalog entry without waiting for a Rama release.
function mergeCatalog(base: CatalogFile, overlay: Partial<CatalogFile>): CatalogFile {
  const byId = new Map(base.providers.map((p) => [p.id, p]));
  for (const override of overlay.providers ?? []) {
    if (!override || typeof override.id !== "string") continue;
    const existing = byId.get(override.id);
    if (!existing) {
      byId.set(override.id, override as CatalogProvider);
      continue;
    }
    const modelsById = new Map(existing.models.map((m) => [m.id, m]));
    for (const model of override.models ?? []) {
      if (!model || typeof model.id !== "string") continue;
      const base = modelsById.get(model.id);
      modelsById.set(model.id, base ? { ...base, ...model } : (model as CatalogModel));
    }
    byId.set(override.id, { ...existing, ...override, models: [...modelsById.values()] });
  }
  return { providers: [...byId.values()] };
}

let cached: CatalogFile | null = null;

// A typo in ~/.rama/catalog.json must never keep the engine from booting — same tolerance as
// themes/store.ts gives a bad theme file. On any parse/shape failure this just falls back to the
// bundled catalog and logs, rather than throwing.
export function getCatalog(): CatalogFile {
  if (cached) return cached;
  let result = loadBundledCatalog();
  if (existsSync(USER_CATALOG_PATH)) {
    try {
      const overlay = JSON.parse(readFileSync(USER_CATALOG_PATH, "utf8"));
      if (overlay && typeof overlay === "object") {
        result = mergeCatalog(result, overlay as Partial<CatalogFile>);
      }
    } catch (err) {
      console.error(`[catalog] ignoring ~/.rama/catalog.json: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  cached = result;
  return result;
}

export function getCatalogProvider(id: string): CatalogProvider | undefined {
  return getCatalog().providers.find((p) => p.id === id);
}

export function getCatalogModel(providerId: string, modelId: string): CatalogModel | undefined {
  return getCatalogProvider(providerId)?.models.find((m) => m.id === modelId);
}
