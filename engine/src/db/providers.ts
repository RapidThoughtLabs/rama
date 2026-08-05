import type { ProviderDTO, ProviderKind } from "@rama/protocol";
import { getModelsForProvider } from "../agent/config";
import { db } from "./index";

export interface ProviderRow {
  id: string;
  kind: ProviderKind;
  base_url: string | null;
  label: string | null;
  created_at: number;
}

interface SeedProvider {
  id: string;
  kind: ProviderKind;
  baseUrl: string | null;
  label: string;
  requiresKey: boolean;
}

// Static roster of providers Rama ships adapters for. `openai-compatible` entries all go
// through the same @ai-sdk/openai-compatible adapter (loop.ts); `anthropic` uses the native
// @ai-sdk/anthropic adapter. Ollama is the one entry that doesn't need a key — it's a local
// unauthenticated endpoint.
const SEED_PROVIDERS: SeedProvider[] = [
  { id: "together", kind: "openai-compatible", baseUrl: "https://api.together.xyz/v1", label: "Together AI", requiresKey: true },
  { id: "openai", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", label: "OpenAI", requiresKey: true },
  { id: "groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", label: "Groq", requiresKey: true },
  { id: "openrouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", label: "OpenRouter", requiresKey: true },
  { id: "ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", label: "Ollama (local)", requiresKey: false },
  { id: "anthropic", kind: "anthropic", baseUrl: null, label: "Anthropic", requiresKey: true },
];

const REQUIRES_KEY: Record<string, boolean> = Object.fromEntries(SEED_PROVIDERS.map((p) => [p.id, p.requiresKey]));

// Idempotent — safe to call on every boot. INSERT OR IGNORE means a provider row already
// present (e.g. from Phase 3, before Phase 4 added the rest) keeps its existing values.
export function seedProviders(): void {
  const now = Date.now();
  for (const p of SEED_PROVIDERS) {
    db.query(
      `INSERT OR IGNORE INTO providers (id, kind, base_url, label, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(p.id, p.kind, p.baseUrl, p.label, now);
  }
}

export function getProvider(id: string): ProviderRow | null {
  return db.query<ProviderRow, [string]>("SELECT * FROM providers WHERE id = ?").get(id);
}

export function providerRequiresKey(id: string): boolean {
  return REQUIRES_KEY[id] ?? true;
}

export function listProviders(): ProviderDTO[] {
  const rows = db.query<ProviderRow, []>("SELECT * FROM providers ORDER BY created_at ASC").all();
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label ?? row.id,
    baseUrl: row.base_url,
    requiresKey: REQUIRES_KEY[row.id] ?? true,
    models: getModelsForProvider(row.id),
  }));
}
