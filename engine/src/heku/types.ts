import type { ToolRisk } from "../tools/types";

export interface HekuToolRow {
  full_id: string;
  server_id: string;
  server_name: string;
  tool_name: string;
  description: string;
  schema_json: string;
  risk: ToolRisk;
  pinned: number;
  call_count: number;
  last_called_at: number | null;
  indexed_at: number;
}

// docs/TOOL_LAYER_PLAN.md §7.6 — pinned tools are the row's own `pinned` column (user-chosen, no
// settings UI yet — same "plumbing before the pane" precedent as TL6's chat_todos); this only
// covers the auto-promote side, read/written under settings key "heku".
export interface HekuPromotionPolicy {
  autoPromote: boolean;
  autoPromoteThreshold: number;
  maxPromoted: number;
}
