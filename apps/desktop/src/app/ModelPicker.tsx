import { useEffect, useRef, useState } from "react";
import type { ChatDTO, ModelInfo, ProviderDTO, ProviderHealthDTO, ProviderHealthStatus } from "@rama/protocol";
import { patchChat } from "../engine/client";
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

const RECENTS_KEY = "rama.recentModels";
const MAX_RECENTS = 5;

interface RecentPick {
  providerId: string;
  modelId: string;
}

function loadRecents(): RecentPick[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((r) => r && typeof r.providerId === "string" && typeof r.modelId === "string") : [];
  } catch {
    return [];
  }
}

function pushRecent(providerId: string, modelId: string): RecentPick[] {
  const existing = loadRecents().filter((r) => !(r.providerId === providerId && r.modelId === modelId));
  const next = [{ providerId, modelId }, ...existing].slice(0, MAX_RECENTS);
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // best-effort — a full/blocked localStorage just means no recents section, not a crash
  }
  return next;
}

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

export function ModelPicker({ chat, disabled }: { chat: ChatDTO | undefined; disabled: boolean }) {
  const { providers, health } = useProvidersData();
  const { open: openSettings } = useSettingsLink();
  const [menuOpen, setMenuOpen] = useState(false);
  const [recents, setRecents] = useState<RecentPick[]>(() => loadRecents());
  const rootRef = useRef<HTMLDivElement>(null);

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

  const activeProvider = providers.find((p) => p.id === chat?.providerId);
  const activeModel = activeProvider?.models.find((m) => m.id === chat?.model);
  // The pill is exempt from the filter entirely — it always reflects live health, not the
  // snapshot, since it's showing current state rather than making an offer.
  const pillStatus: ProviderHealthStatus = chat ? healthOf(health, chat.providerId) : "checking";
  const pillUnavailable = !!chat && !providerVisible(pillStatus);

  function choose(providerId: string, modelId: string) {
    setMenuOpen(false);
    setRecents(pushRecent(providerId, modelId));
    if (!chat || (providerId === chat.providerId && modelId === chat.model)) return;
    patchChat(chat.id, { providerId, model: modelId }).catch((err) => {
      console.error("[rama] failed to switch provider/model", err);
    });
  }

  const list = snapshot;
  const visibleProviders = list ? list.providers.filter((p) => providerVisible(healthOf(list.health, p.id))) : [];
  const visibleProviderIds = new Set(visibleProviders.map((p) => p.id));

  const recentEntries = list
    ? recents
        .filter((r) => visibleProviderIds.has(r.providerId))
        .map((r) => {
          const provider = list.providers.find((p) => p.id === r.providerId);
          const model = provider?.models.find((m) => m.id === r.modelId);
          return provider && model ? { provider, model } : null;
        })
        .filter((e): e is { provider: ProviderDTO; model: ModelInfo } => e !== null)
    : [];

  // The current chat's own unhealthy provider isn't in the list (guard 3) — it's the banner.
  const bannerProvider = chat && !providerVisible(pillStatus) ? activeProvider ?? { id: chat.providerId, label: chat.providerId } : null;
  const bannerError = chat ? health[chat.providerId]?.error : null;

  return (
    <div className="rama-model-picker" ref={rootRef}>
      <button type="button" className="rama-model-pill" disabled={!chat || disabled} onClick={toggleMenu}>
        <span
          className="rama-accent-dot"
          style={{ width: 6, height: 6, background: STATUS_COLOR[pillStatus], boxShadow: "none" }}
        />
        <span>{activeProvider ? `${activeProvider.label} · ${activeModel?.label ?? chat?.model}` : (chat?.model ?? "no model")}</span>
        {pillUnavailable && <span className="rama-model-pill-bad">unavailable</span>}
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

          {recentEntries.length > 0 && (
            <div className="rama-model-menu-group">
              <div className="rama-model-menu-group-label">recent</div>
              {recentEntries.map(({ provider, model }) => (
                <button
                  type="button"
                  key={`${provider.id}:${model.id}`}
                  className={
                    "rama-model-menu-item" +
                    (chat?.providerId === provider.id && chat?.model === model.id ? " rama-model-menu-item-active" : "")
                  }
                  onClick={() => choose(provider.id, model.id)}
                >
                  <span>
                    {provider.label} · {model.label}
                  </span>
                </button>
              ))}
            </div>
          )}

          {visibleProviders.map((p) => {
            const models = p.models.filter((m) => modelVisible(m, chat?.providerId === p.id && chat?.model === m.id));
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
                      (chat?.providerId === p.id && chat?.model === m.id ? " rama-model-menu-item-active" : "")
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

          {visibleProviders.every((p) => p.models.every((m) => !modelVisible(m, chat?.providerId === p.id && chat?.model === m.id))) && (
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
