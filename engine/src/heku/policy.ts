import { getSetting, setSetting } from "../db/settings";
import type { ToolRisk } from "../tools/types";
import type { HekuPromotionPolicy, HekuToolRow } from "./types";

const SETTINGS_KEY = "heku";
const RISK_OVERRIDES_KEY = "heku_risk_overrides";

const DEFAULT_POLICY: HekuPromotionPolicy = {
  autoPromote: true,
  autoPromoteThreshold: 3,
  maxPromoted: 5,
};

export function getPromotionPolicy(): HekuPromotionPolicy {
  return { ...DEFAULT_POLICY, ...(getSetting<Partial<HekuPromotionPolicy>>(SETTINGS_KEY) ?? {}) };
}

export function setPromotionPolicy(patch: Partial<HekuPromotionPolicy>): HekuPromotionPolicy {
  const next = { ...getPromotionPolicy(), ...patch };
  setSetting(SETTINGS_KEY, next);
  return next;
}

// §7.2 — "per-server and per-tool policy, allowlists... the gateway is where it becomes granular
// without becoming scattered." No settings UI writes this yet (same plumbing-before-the-pane
// precedent as chat_todos in TL6); every indexed tool defaults to `row.risk` ("high", set at index
// time) until an explicit override downgrades a specific full_id to "low".
export function resolveRisk(row: Pick<HekuToolRow, "full_id" | "risk">): ToolRisk {
  const overrides = getSetting<Record<string, ToolRisk>>(RISK_OVERRIDES_KEY) ?? {};
  return overrides[row.full_id] ?? row.risk;
}

export function setRiskOverride(fullId: string, risk: ToolRisk | null): void {
  const overrides = { ...(getSetting<Record<string, ToolRisk>>(RISK_OVERRIDES_KEY) ?? {}) };
  if (risk) overrides[fullId] = risk;
  else delete overrides[fullId];
  setSetting(RISK_OVERRIDES_KEY, overrides);
}
