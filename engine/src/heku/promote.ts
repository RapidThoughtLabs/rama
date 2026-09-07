import { getPromotionPolicy } from "./policy";
import { listAllTools } from "./store";
import type { HekuToolRow } from "./types";

// §7.6 — "Promoted tools are generated as real tool() entries with their own schemas... the
// budget stays a budget": pinned rows always win a slot; autoPromote fills the rest by call
// volume. Both draw from the same maxPromoted cap, so pinning everything starves auto-promotion
// rather than silently exceeding the budget.
export function getPromotedTools(): HekuToolRow[] {
  const policy = getPromotionPolicy();
  const all = listAllTools();

  const pinned = all.filter((t) => t.pinned);
  const slotsLeft = Math.max(0, policy.maxPromoted - pinned.length);

  const autoPromoted = policy.autoPromote
    ? all
        .filter((t) => !t.pinned && t.call_count >= policy.autoPromoteThreshold)
        .sort((a, b) => b.call_count - a.call_count)
        .slice(0, slotsLeft)
    : [];

  return [...pinned.slice(0, policy.maxPromoted), ...autoPromoted];
}
