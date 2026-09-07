// Full data model per docs/IMPLEMENTATION_PLAN.md §4. Phase 1 only ships DAOs/endpoints for
// `projects` and `chats`; the rest are laid down now so Phase 2/3 don't need a migration step.

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  repo_url TEXT,
  default_branch TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  backend_json TEXT NOT NULL DEFAULT '{}',
  provider_id TEXT NOT NULL DEFAULT 'together',
  model TEXT,
  mode TEXT NOT NULL DEFAULT 'agent',
  wallpaper TEXT NOT NULL DEFAULT 'indigo', -- dead: SETTINGS_PLAN.md Phase S0, wallpaper moved into the theme record
  theme_id TEXT NOT NULL DEFAULT 'kanagawa',
  accent TEXT NOT NULL DEFAULT 'plasma', -- dead: superseded by theme_id (docs/REDESIGN_PLAN.md Phase R0)
  theme TEXT NOT NULL DEFAULT 'dark', -- dead: superseded by theme_id (docs/REDESIGN_PLAN.md Phase R0)
  status TEXT NOT NULL DEFAULT 'idle',
  cost_usd REAL NOT NULL DEFAULT 0,
  utility_cost_usd REAL NOT NULL DEFAULT 0, -- docs/PROVIDERS_PLAN.md Phase P2: role='utility' spend, kept out of cost_usd so a title call never pollutes the chat's own cost line
  context_used INTEGER NOT NULL DEFAULT 0,
  context_max INTEGER NOT NULL DEFAULT 200000,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_project ON chats(project_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT,
  thinking TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  chat_id TEXT NOT NULL REFERENCES chats(id),
  name TEXT NOT NULL,
  input_json TEXT NOT NULL DEFAULT '{}',
  ok INTEGER,
  result_summary TEXT,
  result_content TEXT,
  result_meta_json TEXT,
  started_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  message_id TEXT,
  tool_call_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  body_hash TEXT,
  body_inline TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'done',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_chat ON artifacts(chat_id);

CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  base_url TEXT,
  label TEXT,
  created_at INTEGER NOT NULL
);

-- docs/PROVIDERS_PLAN.md Phase P0 — the roster/catalog merge target. One row per model a
-- provider is known to have (catalog-known) or has actually listed (fetch-known), or both. Status
-- (available/unverified/missing/erroring) is derived at read time from fetched_at/last_seen_at/
-- last_error_kind against providers.last_health_at, never stored, so a schema change here never
-- means a backfill. enabled/pinned/added_manually are user state and nothing in P0 writes them.
CREATE TABLE IF NOT EXISTS provider_models (
  provider_id      TEXT NOT NULL,
  model_id         TEXT NOT NULL,
  label            TEXT,
  enabled          INTEGER NOT NULL DEFAULT 0,
  pinned           INTEGER NOT NULL DEFAULT 0,
  in_catalog       INTEGER NOT NULL DEFAULT 0,
  fetched_at       INTEGER,
  added_manually   INTEGER NOT NULL DEFAULT 0,
  supports_tools   INTEGER,
  supports_thinking INTEGER,
  supports_vision  INTEGER,
  context_window   INTEGER,
  input_per_million  REAL,
  output_per_million REAL,
  price_source     TEXT,
  tier             TEXT,
  first_seen_at    INTEGER NOT NULL,
  last_seen_at     INTEGER NOT NULL,
  deprecated       INTEGER NOT NULL DEFAULT 0,
  superseded_by    TEXT,
  last_error       TEXT,
  last_error_at    INTEGER,
  last_error_kind  TEXT,
  PRIMARY KEY (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

-- docs/PROVIDERS_PLAN.md Phase P2 — a role points at one provider+model, not a "cheap model"
-- setting. 'chat' replaces DEFAULT_PROVIDER_ID/DEFAULT_MODEL; 'utility' backs auto-titling and
-- other background calls; 'summarize' is named for compaction but unwired (no row until it lands).
CREATE TABLE IF NOT EXISTS model_roles (
  role        TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  installed_at INTEGER NOT NULL
);

-- docs/TOOL_LAYER_PLAN.md §5.1 — the read-before-write precondition's backing store. A table,
-- not a Map, so it survives across turns in a chat the way an in-process cache wouldn't.
CREATE TABLE IF NOT EXISTS file_reads (
  chat_id   TEXT NOT NULL REFERENCES chats(id),
  path      TEXT NOT NULL,
  mtime_ms  INTEGER NOT NULL,
  size      INTEGER NOT NULL,
  read_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, path)
);

-- docs/MISSION_CONTROL_PLAN.md §5.1 (Phase M2) — project-scoped, not chat-scoped: a terminal
-- outlives whichever chat/window happens to be looking at it. Scrollback reuses artifacts.ts's
-- exact inline/blob storage strategy and its MAX_TERMINAL_BODY_BYTES trailing cap (db/terminals.ts).
CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  cwd TEXT NOT NULL,
  shell TEXT NOT NULL,
  argv_json TEXT NOT NULL DEFAULT '[]',
  owner TEXT NOT NULL DEFAULT 'user',          -- 'user' | 'agent'
  origin_chat_id TEXT REFERENCES chats(id),    -- set iff owner='agent'
  status TEXT NOT NULL DEFAULT 'running',      -- 'running' | 'exited'
  exit_code INTEGER,
  scrollback_hash TEXT,
  scrollback_inline TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_terminals_project ON terminals(project_id);

-- docs/TOOL_LAYER_PLAN.md §6.14 (TL6) — one row per chat, the whole list replaced/mutated in
-- place by db/todos.ts. Not a per-item table: 'set' always overwrites the full list, so there is
-- no cross-call item identity to key rows on beyond array index.
CREATE TABLE IF NOT EXISTS chat_todos (
  chat_id TEXT PRIMARY KEY REFERENCES chats(id),
  items_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- docs/TOOL_LAYER_PLAN.md §7.4 (TL7) — one row per external tool, normalised at index time so a
-- third-party MCP tool's description is prompt-quality by the time heku_find shows it. full_id
-- ("<server_id>.<tool_name>") is what heku_call and promotion key on. call_count/last_called_at/
-- pinned survive re-indexing (indexer.ts's upsert never touches them) so usage history isn't lost
-- every time a server reconnects.
CREATE TABLE IF NOT EXISTS heku_tools (
  full_id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  description TEXT NOT NULL,
  schema_json TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'high',
  pinned INTEGER NOT NULL DEFAULT 0,
  call_count INTEGER NOT NULL DEFAULT 0,
  last_called_at INTEGER,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_heku_tools_server ON heku_tools(server_id);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;
