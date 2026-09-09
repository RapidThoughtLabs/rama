// Generic key/value settings store (the `settings` table has existed since Phase 1's schema but
// had no reader/writer until now). docs/REDESIGN_PLAN.md Phase R4's Settings modal is the only
// consumer today — general prefs under key "general", global permission defaults under
// "permissions" — but any future app-wide preference can reuse this rather than growing its own
// table.

import type { PermissionSettings } from "@rama/protocol";
import { db } from "./index";

// Shared with server.ts's /settings/permissions routes and agent/permissions.ts's gate() — one
// definition so the enforced defaults can never drift from the defaults the Settings UI displays.
export const DEFAULT_PERMISSIONS: PermissionSettings = { bash: "ask", write: "ask", edit: "allow", web: "allow" };

interface SettingRow {
  key: string;
  value_json: string;
}

export function getSetting<T>(key: string): T | null {
  const row = db.query<SettingRow, [string]>("SELECT * FROM settings WHERE key = ?").get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value_json) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  db.query(
    "INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
  ).run(key, JSON.stringify(value));
}
