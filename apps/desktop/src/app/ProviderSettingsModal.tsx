import { useState } from "react";
import { Button, Input, Modal, useToast } from "@rama/ui";
import type { ProviderHealthStatus } from "@rama/protocol";
import { useProvidersData } from "./data/ProvidersProvider";

// Phase 4 credential management (docs/IMPLEMENTATION_PLAN.md Phase 4): add/update a provider's
// API key. Keys are written straight to the OS keychain + pushed to the engine's in-memory
// store via ProvidersProvider.saveProviderKey — never persisted in SQLite or in this component.

const STATUS_LABEL: Record<ProviderHealthStatus, string> = {
  ok: "connected",
  bad: "error",
  "no-key": "no key",
  checking: "checking…",
};
const STATUS_COLOR: Record<ProviderHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  "no-key": "var(--warn)",
  checking: "var(--warn)",
};

export function ProviderSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { providers, health, saveProviderKey } = useProvidersData();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const { push } = useToast();

  async function handleSave(providerId: string, label: string) {
    const key = drafts[providerId]?.trim();
    if (!key) return;
    setSavingId(providerId);
    try {
      await saveProviderKey(providerId, key);
      setDrafts((prev) => ({ ...prev, [providerId]: "" }));
      push(`saved ${label} key`, "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSavingId(null);
    }
  }

  return (
    <Modal open={open} title="provider settings" onClose={onClose}>
      <div className="rama-provider-settings">
        {providers.map((p) => {
          const status = health[p.id]?.status ?? "checking";
          return (
            <div key={p.id} className="rama-provider-settings-row">
              <div className="rama-provider-settings-head">
                <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[status] }} />
                <span className="rama-provider-settings-label">{p.label}</span>
                <span className="rama-provider-settings-status">{STATUS_LABEL[status]}</span>
              </div>
              {p.requiresKey ? (
                <div className="rama-provider-settings-input-row">
                  <Input
                    type="password"
                    placeholder={status === "ok" ? "•••••••• (key saved)" : "paste API key…"}
                    value={drafts[p.id] ?? ""}
                    onChange={(e) => setDrafts((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleSave(p.id, p.label)}
                    disabled={!drafts[p.id]?.trim() || savingId === p.id}
                  >
                    {savingId === p.id ? "saving…" : "save"}
                  </Button>
                </div>
              ) : (
                <div className="rama-provider-settings-hint">local endpoint, no key needed — {p.baseUrl}</div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
