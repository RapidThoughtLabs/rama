import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema";

export const RAMA_HOME = join(homedir(), ".rama");
export const BLOBS_DIR = join(RAMA_HOME, "blobs");

mkdirSync(RAMA_HOME, { recursive: true });
mkdirSync(BLOBS_DIR, { recursive: true });

export const db = new Database(join(RAMA_HOME, "rama.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
db.exec(SCHEMA_SQL);

// SCHEMA_SQL only CREATEs tables that don't exist yet, so columns added after a table's first
// release need an explicit ALTER TABLE here too — guarded because SQLite has no "ADD COLUMN IF
// NOT EXISTS" and re-running it on a DB that already has the column would otherwise throw.
function addColumnIfMissing(table: string, column: string, ddl: string): boolean {
  const existing = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (existing.some((c) => c.name === column)) return false;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  return true;
}

addColumnIfMissing("chats", "provider_id", "provider_id TEXT NOT NULL DEFAULT 'together'");

// docs/REDESIGN_PLAN.md Phase R0 — `theme_id` replaces `theme`+`accent` as the DTO/UI-facing
// column; those two stay in the table for one release (nothing reads them anymore) rather than
// dropping columns on an existing DB. Existing rows get `theme_id` back-filled from their old
// theme+accent pair via the same conservative mapping as themes.ts's migrateLegacyTheme, run
// once here since the DB layer doesn't import UI code.
if (addColumnIfMissing("chats", "theme_id", "theme_id TEXT NOT NULL DEFAULT 'kanagawa'")) {
  db.exec(`
    UPDATE chats SET theme_id = CASE
      WHEN theme = 'light' THEN 'foam'
      WHEN accent = 'frost' THEN 'kanagawa'
      ELSE 'sumi'
    END
  `);
}

// docs/PROVIDERS_PLAN.md Phase P0 — roster state piggybacked onto the existing 30s health probe
// (engine/src/providerHealth.ts) and read back through engine/src/db/providerModels.ts.
addColumnIfMissing("providers", "models_hash", "models_hash TEXT");
addColumnIfMissing("providers", "models_fetched_at", "models_fetched_at INTEGER");
addColumnIfMissing("providers", "last_health_status", "last_health_status TEXT");
addColumnIfMissing("providers", "last_health_at", "last_health_at INTEGER");

// docs/PROVIDERS_PLAN.md Phase P3 — "a provider row means the user configured this." seedProviders()
// is gone; these columns are what a deliberately-configured (or, for is_custom, hand-entered)
// provider actually needs. requires_key/auth_style/auth_header/extra_headers_json are copied from
// the catalog at configure time (see db/providers.ts's configureProvider) rather than re-derived
// from a hardcoded id map, which is what let REQUIRES_KEY silently lie for any custom provider.
addColumnIfMissing("providers", "is_custom", "is_custom INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("providers", "enabled", "enabled INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("providers", "requires_key", "requires_key INTEGER NOT NULL DEFAULT 1");
addColumnIfMissing("providers", "auth_style", "auth_style TEXT NOT NULL DEFAULT 'bearer'");
addColumnIfMissing("providers", "auth_header", "auth_header TEXT");
addColumnIfMissing("providers", "extra_headers_json", "extra_headers_json TEXT NOT NULL DEFAULT '{}'");

// docs/PROVIDERS_PLAN.md Phase P2 — utility-role spend, tracked separately from cost_usd.
addColumnIfMissing("chats", "utility_cost_usd", "utility_cost_usd REAL NOT NULL DEFAULT 0");

// docs/TOOL_LAYER_PLAN.md Phase TL0 — carries what the model actually saw (not just the UI
// summary) so a later turn can rebuild real tool-call/tool-result history instead of losing it.
addColumnIfMissing("tool_calls", "result_content", "result_content TEXT");
addColumnIfMissing("tool_calls", "result_meta_json", "result_meta_json TEXT");

// docs/PROMPT_STACK_PLAN.md Phase PS4 — which agent file (engine/src/agent/agents/discover.ts)
// shapes this chat's bp2 agent block. 'default' is the bundled floor agent, always present.
addColumnIfMissing("chats", "agent_id", "agent_id TEXT NOT NULL DEFAULT 'default'");

// docs/CONTEXT_BUDGET_PLAN.md CB2 — persists the decay decision (D1: the raw result_content is
// never mutated) so buildTranscriptFromDb's projection survives a reload instead of re-deriving
// it from a working copy that dies with the run.
addColumnIfMissing("tool_calls", "decayed_at", "decayed_at INTEGER");

// docs/COMPOSER_CONTEXT_PLAN.md Phase CC1/CC2 — extraRoots + worktree state, mirrors
// projects.settings_json (added below its own CREATE TABLE for the same reason).
addColumnIfMissing("chats", "settings_json", "settings_json TEXT NOT NULL DEFAULT '{}'");
