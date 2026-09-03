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

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  description TEXT,
  installed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  transport_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
`;
