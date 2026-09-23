import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ChatDTO, ModelInfo, ProviderDTO, ProviderHealthDTO, ProviderHealthStatus } from "@rama/protocol";
import { patchChat } from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useSettingsLink } from "./data/SettingsLinkContext";
import { useProvidersData } from "./data/ProvidersProvider";

// docs/PROVIDERS_PLAN.md Phase P1 — "hide, do not demote": a provider that's erroring or missing
// its key doesn't appear in the picker at all, and neither does a model that's gone missing or
// started erroring. Three guards make that safe (see below); this replaces Phase 4's picker,
// which rendered every provider and every model regardless of health.

const STATUS_COLOR: Record<ProviderHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  "no-key": "var(--warn)",
  checking: "var(--warn)",
};

// Guard 1 — `checking` counts as visible. Hide only on a resolved bad status; a provider still
// mid-first-check (or persistently offline) must not make the whole picker look empty.
function providerVisible(status: ProviderHealthStatus): boolean {
  return status === "ok" || status === "checking";
}

// "Excluded: missing models unless currently selected, and erroring ones." A model that's still
// the active selection stays visible (greyed via its own status, not filtered away) so opening
// the picker never makes the current pick vanish out from under the user.
//
// docs/PROVIDERS_PLAN.md Phase P4 — closes out P1's interim deviation: `enabled` was universally
// 0 until this phase shipped the UI to set it (fast-add's defaultEnabled tick, the providers
// pane's per-model toggle), so filtering on it any earlier would have emptied every picker.
function modelVisible(model: ModelInfo, isCurrentSelection: boolean): boolean {
  if (isCurrentSelection) return true;
  return model.enabled && model.status !== "missing" && model.status !== "erroring";
}

function healthOf(health: Record<string, ProviderHealthDTO>, providerId: string): ProviderHealthStatus {
  return health[providerId]?.status ?? "checking";
}

export function ModelPicker({
  chat,
  disabled,
  draftValue,
  onDraftChange,
}: {
  chat: ChatDTO | undefined;
  disabled: boolean;
  // A draft has no ChatDTO yet (ProjectsProvider.DraftChat), so there's no `chat.id` to PATCH —
  // these two carry the same picker through that case, writing into the draft instead.
  draftValue?: { providerId: string | null; model: string | null };
  onDraftChange?: (providerId: string, model: string) => void;
}) {
  const { providers, health } = useProvidersData();
  const { applyChatPatch } = useProjectsData();
  const { open: openSettings } = useSettingsLink();
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const isDraft = !chat && !!draftValue;
  const currentProviderId = chat?.providerId ?? draftValue?.providerId ?? null;
  const currentModel = chat?.model ?? draftValue?.model ?? null;

  // Guard 2, second half — "the list never re-filters while the menu is open." Snapshotting
  // providers+health at the moment the menu opens means the live 30s poll (or a hysteresis flip)
  // can't reorder or prune the list out from under the cursor; the next open takes a fresh one.
  const [snapshot, setSnapshot] = useState<{ providers: ProviderDTO[]; health: Record<string, ProviderHealthDTO> } | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  function toggleMenu() {
    setMenuOpen((wasOpen) => {
      if (!wasOpen) setSnapshot({ providers, health });
      return !wasOpen;
    });
  }

  // Escape closes the menu and keeps focus on the tile (standard combobox behavior) — a second
  // Escape, once the menu is already closed, is left to the composer rail's own handler, which
  // sends focus back to the text area.
  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      e.stopPropagation();
      setMenuOpen(false);
    }
  }

  const activeProvider = providers.find((p) => p.id === currentProviderId);
  const activeModel = activeProvider?.models.find((m) => m.id === currentModel);
  // The pill is exempt from the filter entirely — it always reflects live health, not the
  // snapshot, since it's showing current state rather than making an offer.
  const pillStatus: ProviderHealthStatus = currentProviderId ? healthOf(health, currentProviderId) : "checking";
  const pillUnavailable = !!currentProviderId && !providerVisible(pillStatus);

  function choose(providerId: string, modelId: string) {
    setMenuOpen(false);
    if (providerId === currentProviderId && modelId === currentModel) return;
    if (isDraft) {
      onDraftChange?.(providerId, modelId);
      return;
    }
    if (!chat) return;
    patchChat(chat.id, { providerId, model: modelId })
      .then(applyChatPatch)
      .catch((err) => {
        console.error("[rama] failed to switch provider/model", err);
      });
  }

  const list = snapshot;
  const visibleProviders = list ? list.providers.filter((p) => providerVisible(healthOf(list.health, p.id))) : [];
  // The current selection's own unhealthy provider isn't in the list (guard 3) — it's the banner.
  const bannerProvider =
    currentProviderId && !providerVisible(pillStatus) ? (activeProvider ?? { id: currentProviderId, label: currentProviderId }) : null;
  const bannerError = currentProviderId ? health[currentProviderId]?.error : null;

  return (
    <div className="rama-tile-wrap" ref={rootRef}>
      <button
        type="button"
        className={`rama-tile rama-tile-model${menuOpen ? " rama-tile-open" : ""}`}
        disabled={(!chat && !isDraft) || disabled}
        onClick={toggleMenu}
        onKeyDown={onTriggerKeyDown}
      >
        <span
          className="rama-accent-dot"
          style={{ width: 6, height: 6, background: STATUS_COLOR[pillStatus], boxShadow: "none" }}
        />
        <span>{activeModel?.label ?? currentModel ?? "no model"}</span>
        {pillUnavailable && <span className="rama-tile-unavailable">unavailable</span>}
      </button>
      {menuOpen && (
        <div className="rama-model-menu">
          {bannerProvider && (
            <button
              type="button"
              className="rama-model-menu-banner"
              onClick={() => {
                setMenuOpen(false);
                openSettings({ pane: "providers", providerId: bannerProvider.id });
              }}
            >
              <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[pillStatus] }} />
              {bannerProvider.label} — {pillStatus === "no-key" ? "no key configured" : (bannerError ?? "unavailable")} · fix in settings →
            </button>
          )}

          {visibleProviders.map((p) => {
            const models = p.models.filter((m) => modelVisible(m, currentProviderId === p.id && currentModel === m.id));
            if (models.length === 0) return null;
            return (
              <div key={p.id} className="rama-model-menu-group">
                <div className="rama-model-menu-group-label">
                  <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[healthOf(list!.health, p.id)] }} />
                  {p.label}
                </div>
                {models.map((m) => (
                  <button
                    type="button"
                    key={m.id}
                    className={
                      "rama-model-menu-item" +
                      (currentProviderId === p.id && currentModel === m.id ? " rama-model-menu-item-active" : "")
                    }
                    onClick={() => choose(p.id, m.id)}
                  >
                    <span>{m.label}</span>
                    <span className="rama-model-menu-item-badges">
                      {m.status === "missing" && <span className="rama-model-menu-hint">missing</span>}
                      {m.supportsThinking && <span className="rama-model-menu-badge">thinking</span>}
                    </span>
                  </button>
                ))}
              </div>
            );
          })}

          {visibleProviders.every((p) => p.models.every((m) => !modelVisible(m, currentProviderId === p.id && currentModel === m.id))) && (
            <button
              type="button"
              className="rama-model-menu-empty"
              onClick={() => {
                setMenuOpen(false);
                openSettings({ pane: "providers" });
              }}
            >
              no providers connected — set one up →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
