import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema";
import { seedProviders } from "./providers";

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

seedProviders();
