import { useEffect, useRef, useState } from "react";
import type { ChatDTO, ProviderHealthStatus } from "@rama/protocol";
import { patchChat } from "../engine/client";
import { useProvidersData } from "./data/ProvidersProvider";

// Phase 4 composer control: pick a provider + model per chat (docs/IMPLEMENTATION_PLAN.md
// Phase 4). Replaces the static read-only pill from Phase 2 with a real dropdown over
// ProvidersProvider's live roster + health, persisted via the same patchChat path the mode
// SegmentedControl already uses.

const STATUS_COLOR: Record<ProviderHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  "no-key": "var(--warn)",
  checking: "var(--warn)",
};

export function ModelPicker({ chat, disabled }: { chat: ChatDTO | undefined; disabled: boolean }) {
  const { providers, health } = useProvidersData();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const activeProvider = providers.find((p) => p.id === chat?.providerId);
  const activeModel = activeProvider?.models.find((m) => m.id === chat?.model);
  const status: ProviderHealthStatus = (chat && health[chat.providerId]?.status) || "checking";

  function choose(providerId: string, modelId: string) {
    setOpen(false);
    if (!chat || (providerId === chat.providerId && modelId === chat.model)) return;
    patchChat(chat.id, { providerId, model: modelId }).catch((err) => {
      console.error("[rama] failed to switch provider/model", err);
    });
  }

  return (
    <div className="rama-model-picker" ref={rootRef}>
      <button
        type="button"
        className="rama-model-pill"
        disabled={!chat || disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rama-accent-dot" style={{ width: 6, height: 6, background: STATUS_COLOR[status], boxShadow: "none" }} />
        <span>{activeProvider ? `${activeProvider.label} · ${activeModel?.label ?? chat?.model}` : (chat?.model ?? "no model")}</span>
      </button>
      {open && (
        <div className="rama-model-menu">
          {providers.map((p) => {
            const pStatus = health[p.id]?.status ?? "checking";
            return (
              <div key={p.id} className="rama-model-menu-group">
                <div className="rama-model-menu-group-label">
                  <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[pStatus] }} />
                  {p.label}
                  {pStatus === "no-key" && <span className="rama-model-menu-hint">no key</span>}
                </div>
                {p.models.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={
                      "rama-model-menu-item" +
                      (chat?.providerId === p.id && chat?.model === m.id ? " rama-model-menu-item-active" : "")
                    }
                    onClick={() => choose(p.id, m.id)}
                  >
                    <span>{m.label}</span>
                    {m.supportsThinking && <span className="rama-model-menu-badge">thinking</span>}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
