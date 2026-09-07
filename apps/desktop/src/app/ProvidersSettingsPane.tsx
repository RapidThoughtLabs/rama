import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Input, Toggle, useToast } from "@rama/ui";
import type { CatalogProviderSummaryDTO, ModelInfo, ModelRole, ModelRoleDTO, ProviderDTO, ProviderHealthStatus } from "@rama/protocol";
import {
  addProviderModel,
  createProvider,
  deleteProviderKey,
  fetchCatalogProviders,
  fetchModelRoles,
  removeProvider,
  removeProviderModel,
  setProviderModelEnabled,
  switchProviderModel,
  updateProviderConfig,
} from "../engine/client";
import { useProjectsData } from "./data/ProjectsProvider";
import { useProvidersData } from "./data/ProvidersProvider";
import { ProviderSetupWizard } from "./ProviderSetupWizard";

// docs/PROVIDERS_PLAN.md Phase P4 — "a list of things you added, with an add button", the shape
// `mcp servers` already has. Replaces the flat key-per-row list from Phase P0/P1 (which presented
// six always-there rows regardless of whether Phase P3 says any of them are actually configured).

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

function lastViewedKey(providerId: string): string {
  return `rama.providerLastViewedAt.${providerId}`;
}

function getLastViewedAt(providerId: string): number {
  try {
    return Number(window.localStorage.getItem(lastViewedKey(providerId)) ?? 0) || 0;
  } catch {
    return 0;
  }
}

function markViewedNow(providerId: string): void {
  try {
    window.localStorage.setItem(lastViewedKey(providerId), String(Date.now()));
  } catch {
    // best-effort — worst case the "new" strip reappears next time, not a crash
  }
}

export function ProvidersSettingsPane({ focusProviderId }: { focusProviderId?: string }) {
  const { providers, health, saveProviderKey, refreshHealth, reload } = useProvidersData();
  const [catalog, setCatalog] = useState<CatalogProviderSummaryDTO[]>([]);
  const [roles, setRoles] = useState<Record<ModelRole, ModelRoleDTO | null> | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(focusProviderId ?? null);
  const [wizardOpen, setWizardOpen] = useState(false);
  const rowRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const { push } = useToast();

  useEffect(() => {
    fetchCatalogProviders()
      .then(setCatalog)
      .catch((err) => console.error("[rama] failed to load catalog providers", err));
  }, []);

  function loadRoles() {
    fetchModelRoles()
      .then(setRoles)
      .catch((err) => console.error("[rama] failed to load model roles", err));
  }
  useEffect(loadRoles, []);

  useEffect(() => {
    if (!focusProviderId) return;
    setExpandedId(focusProviderId);
    rowRefs.current[focusProviderId]?.scrollIntoView({ block: "nearest" });
  }, [focusProviderId]);

  const configuredIds = useMemo(() => new Set(providers.map((p) => p.id)), [providers]);
  const addable = catalog.filter((c) => !configuredIds.has(c.id));
  const chatRoleProviderId = roles?.chat?.providerId ?? null;

  async function handleFastAdd(catalogProvider: CatalogProviderSummaryDTO, apiKey: string) {
    if (catalogProvider.requiresKey) {
      await saveProviderKey(catalogProvider.id, apiKey);
    } else {
      await createProvider(catalogProvider.id);
      await reload();
    }
    loadRoles();
    setExpandedId(catalogProvider.id);
    push(`${catalogProvider.label} connected`, "good");
  }

  async function handleRemove(providerId: string, label: string) {
    await removeProvider(providerId);
    await deleteProviderKey(providerId).catch(() => {});
    if (expandedId === providerId) setExpandedId(null);
    await reload();
    loadRoles();
    push(`removed ${label}`, "good");
  }

  if (wizardOpen) {
    return (
      <div className="rama-provider-settings">
        <ProviderSetupWizard
          initialChoice={{ kind: "custom" }}
          onCancel={() => setWizardOpen(false)}
          onDone={(providerId) => {
            setWizardOpen(false);
            setExpandedId(providerId);
          }}
        />
      </div>
    );
  }

  return (
    <div className="rama-provider-settings">
      <div className="rama-provider-add-tiles">
        {addable.map((c) => (
          <AddProviderTile key={c.id} catalogProvider={c} onAdd={(key) => handleFastAdd(c, key)} onError={(err) => push(err, "bad")} />
        ))}
        <button type="button" className="rama-provider-add-tile" onClick={() => setWizardOpen(true)}>
          + custom provider
        </button>
      </div>

      {providers.map((p) => (
        <ProviderCard
          key={p.id}
          provider={p}
          status={health[p.id]?.status ?? "checking"}
          error={health[p.id]?.error ?? null}
          isDefault={chatRoleProviderId === p.id}
          expanded={expandedId === p.id}
          focused={focusProviderId === p.id}
          roles={roles}
          rowRef={(el) => {
            rowRefs.current[p.id] = el;
          }}
          onToggleExpand={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
          onSaveKey={(key) => saveProviderKey(p.id, key)}
          onRecheck={() => refreshHealth(p.id)}
          onRemove={() => handleRemove(p.id, p.label)}
          onReload={reload}
        />
      ))}
    </div>
  );
}

function AddProviderTile({
  catalogProvider,
  onAdd,
  onError,
}: {
  catalogProvider: CatalogProviderSummaryDTO;
  onAdd: (apiKey: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await onAdd(key);
      setKey("");
      setOpen(false);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="rama-provider-add-tile" onClick={() => (catalogProvider.requiresKey ? setOpen(true) : submit())}>
        + {catalogProvider.label}
      </button>
    );
  }

  return (
    <div className="rama-provider-add-tile rama-provider-add-tile-open">
      <div className="rama-provider-settings-input-row">
        <Input
          type="password"
          autoFocus
          placeholder={`${catalogProvider.label} API key…`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && key.trim() && submit()}
        />
        <Button size="sm" onClick={submit} disabled={!key.trim() || busy}>
          {busy ? "verifying…" : "connect"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          cancel
        </Button>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  status,
  error,
  isDefault,
  expanded,
  focused,
  roles,
  rowRef,
  onToggleExpand,
  onSaveKey,
  onRecheck,
  onRemove,
  onReload,
}: {
  provider: ProviderDTO;
  status: ProviderHealthStatus;
  error: string | null;
  isDefault: boolean;
  expanded: boolean;
  focused: boolean;
  roles: Record<ModelRole, ModelRoleDTO | null> | null;
  rowRef: (el: HTMLDivElement | null) => void;
  onToggleExpand: () => void;
  onSaveKey: (key: string) => Promise<void>;
  onRecheck: () => Promise<void>;
  onRemove: () => Promise<void>;
  onReload: () => Promise<void>;
}) {
  const { allChats } = useProjectsData();
  const [keyDraft, setKeyDraft] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [urlDraft, setUrlDraft] = useState(provider.baseUrl ?? "");
  const [savingUrl, setSavingUrl] = useState(false);
  const { push } = useToast();
  const toastedRef = useRef<Set<string>>(new Set());

  const enabledCount = provider.models.filter((m) => m.enabled).length;

  useEffect(() => {
    if (expanded) markViewedNow(provider.id);
  }, [expanded, provider.id]);

  // "The only case that earns a toast is a missing model that is currently a chat's model or a
  // role assignment" — checked on every models update, deduped per (provider, model) via the ref
  // so a 30s health poll that keeps a model `missing` doesn't keep re-toasting it.
  useEffect(() => {
    for (const m of provider.models) {
      if (m.status !== "missing") continue;
      const key = `${provider.id}:${m.id}`;
      if (toastedRef.current.has(key)) continue;
      const usedByChat = allChats.some((c) => c.providerId === provider.id && c.model === m.id);
      const usedByRole = roles ? Object.values(roles).some((r) => r?.providerId === provider.id && r?.modelId === m.id) : false;
      if (usedByChat || usedByRole) {
        toastedRef.current.add(key);
        push(`${m.label} is no longer offered by ${provider.label} — it's still in use`, "bad");
      }
    }
  }, [provider.models, provider.id, provider.label, allChats, roles, push]);

  async function handleSaveKey() {
    const key = keyDraft.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      await onSaveKey(key);
      setKeyDraft("");
      push(`saved ${provider.label} key`, "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSavingKey(false);
    }
  }

  async function handleRecheck() {
    setRechecking(true);
    try {
      await onRecheck();
    } finally {
      setRechecking(false);
    }
  }

  async function handleSaveUrl() {
    if (urlDraft === provider.baseUrl) return;
    setSavingUrl(true);
    try {
      await updateProviderConfig(provider.id, { baseUrl: urlDraft });
      await onReload();
      push("base URL updated", "good");
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setSavingUrl(false);
    }
  }

  return (
    <div ref={rowRef} className={"rama-provider-card" + (focused ? " rama-provider-settings-row-focused" : "")}>
      <button type="button" className="rama-provider-card-head" onClick={onToggleExpand}>
        <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[status] }} />
        <span className="rama-provider-settings-label">{provider.label}</span>
        {provider.baseUrl && <span className="rama-provider-card-url">{provider.baseUrl}</span>}
        <span className="rama-provider-card-count">{enabledCount} model{enabledCount === 1 ? "" : "s"}</span>
        {isDefault && <span className="rama-badge rama-badge-accent">default</span>}
        <span className="rama-provider-card-chevron">{expanded ? "▾" : "▸"}</span>
      </button>

      {!expanded && status !== "ok" && error && <div className="rama-provider-settings-error">{error}</div>}

      {expanded && (
        <div className="rama-provider-card-body">
          <div className="rama-provider-settings-head">
            <span className="rama-provider-settings-status">{STATUS_LABEL[status]}</span>
            {status !== "ok" && error && <span className="rama-provider-settings-error">{error}</span>}
          </div>

          {provider.requiresKey ? (
            <div className="rama-provider-settings-input-row">
              <Input
                type="password"
                placeholder="paste a new API key to replace it…"
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
              <Button size="sm" onClick={handleSaveKey} disabled={!keyDraft.trim() || savingKey}>
                {savingKey ? "saving…" : "replace key"}
              </Button>
            </div>
          ) : (
            <div className="rama-provider-settings-hint">local endpoint, no key needed.</div>
          )}

          <div className="rama-provider-settings-input-row">
            <Input placeholder="base URL" value={urlDraft} onChange={(e) => setUrlDraft(e.target.value)} onBlur={handleSaveUrl} />
            <Button size="sm" variant="ghost" onClick={handleRecheck} disabled={rechecking}>
              {rechecking ? "checking…" : "re-check"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => (confirmingRemove ? onRemove() : setConfirmingRemove(true))}
              onBlur={() => setConfirmingRemove(false)}
            >
              {confirmingRemove ? "confirm remove" : "remove"}
            </Button>
          </div>
          {savingUrl && <div className="rama-settings-hint">saving…</div>}

          <ModelListSection provider={provider} onReload={onReload} />
        </div>
      )}
    </div>
  );
}

const TIER_ORDER: Record<string, number> = { frontier: 0, workhorse: 1, small: 2 };
const CHAT_MODEL_EXCLUDE = /embed|whisper|tts|dall-e|dalle|rerank|moderat/i;
const SNAPSHOT_SUFFIX = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;

function baseModelId(id: string): string {
  return id.replace(SNAPSHOT_SUFFIX, "");
}

interface ModelGroup {
  baseId: string;
  primary: ModelInfo;
  snapshots: ModelInfo[];
}

function groupSnapshots(models: ModelInfo[]): ModelGroup[] {
  const byBase = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const baseId = baseModelId(m.id);
    const list = byBase.get(baseId) ?? [];
    list.push(m);
    byBase.set(baseId, list);
  }
  return [...byBase.entries()].map(([baseId, members]) => {
    const sorted = [...members].sort((a, b) => b.firstSeenAt - a.firstSeenAt);
    return { baseId, primary: sorted[0], snapshots: sorted.slice(1) };
  });
}

function sortGroups(groups: ModelGroup[]): ModelGroup[] {
  return [...groups].sort((a, b) => {
    const ta = TIER_ORDER[a.primary.tier ?? ""] ?? 3;
    const tb = TIER_ORDER[b.primary.tier ?? ""] ?? 3;
    if (ta !== tb) return ta - tb;
    const pa = a.primary.pricing?.inputPerMillion ?? Infinity;
    const pb = b.primary.pricing?.inputPerMillion ?? Infinity;
    if (pa !== pb) return pa - pb;
    return a.primary.label.localeCompare(b.primary.label);
  });
}

export function ModelListSection({ provider, onReload }: { provider: ProviderDTO; onReload: () => Promise<void> }) {
  const [search, setSearch] = useState("");
  const [wantTools, setWantTools] = useState(false);
  const [wantThinking, setWantThinking] = useState(false);
  const [wantVision, setWantVision] = useState(false);
  const [chatModelsOnly, setChatModelsOnly] = useState(true);
  // A brand-new provider (Phase P5's wizard, or a custom provider added straight from its card)
  // starts with nothing catalog-known, manual, or enabled — the curated default view would render
  // empty with no visible way to discover the "show all" escape hatch. Only the initial mount value
  // is lazy; ticking a model afterward doesn't yank the view back to curated under the user.
  const [showAll, setShowAll] = useState(() => !provider.models.some((m) => m.inCatalog || m.addedManually || m.enabled));
  const [manualId, setManualId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const { push } = useToast();

  const lastViewedAt = useMemo(() => getLastViewedAt(provider.id), [provider.id]);
  const newModels = provider.models.filter((m) => m.firstSeenAt > lastViewedAt && !m.enabled);

  let visible = showAll ? provider.models : provider.models.filter((m) => m.inCatalog || m.addedManually || m.enabled);
  if (chatModelsOnly) visible = visible.filter((m) => !CHAT_MODEL_EXCLUDE.test(m.id) && !CHAT_MODEL_EXCLUDE.test(m.label));
  if (wantTools) visible = visible.filter((m) => m.supportsTools);
  if (wantThinking) visible = visible.filter((m) => m.supportsThinking);
  if (wantVision) visible = visible.filter((m) => m.supportsVision);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    visible = visible.filter((m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q));
  }

  const groups = sortGroups(groupSnapshots(visible));
  const totalCount = provider.models.length;

  async function withBusy(id: string, fn: () => Promise<unknown>) {
    setBusyId(id);
    try {
      await fn();
      await onReload();
    } catch (err) {
      push(err instanceof Error ? err.message : String(err), "bad");
    } finally {
      setBusyId(null);
    }
  }

  async function handleAddManual() {
    const id = manualId.trim();
    if (!id) return;
    await withBusy(id, () => addProviderModel(provider.id, id));
    setManualId("");
  }

  return (
    <div className="rama-model-list">
      {newModels.length > 0 && (
        <div className="rama-model-list-new-strip">
          new since you last looked: {newModels.map((m) => m.label).join(", ")}
        </div>
      )}

      <div className="rama-model-list-filters">
        <Input placeholder="search models…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="rama-model-list-check">
          <input type="checkbox" checked={wantTools} onChange={(e) => setWantTools(e.target.checked)} /> tools
        </label>
        <label className="rama-model-list-check">
          <input type="checkbox" checked={wantThinking} onChange={(e) => setWantThinking(e.target.checked)} /> thinking
        </label>
        <label className="rama-model-list-check">
          <input type="checkbox" checked={wantVision} onChange={(e) => setWantVision(e.target.checked)} /> vision
        </label>
        <Toggle checked={chatModelsOnly} onChange={setChatModelsOnly} label="chat models only" />
      </div>

      {groups.map((g) => (
        <ModelRow key={g.baseId} group={g} providerId={provider.id} busyId={busyId} onWithBusy={withBusy} />
      ))}

      {groups.length === 0 && <div className="rama-provider-settings-hint">no models match these filters.</div>}

      {!showAll && totalCount > visible.length && (
        <button type="button" className="rama-model-list-showall" onClick={() => setShowAll(true)}>
          show all {totalCount} models from this provider
        </button>
      )}
      {showAll && (
        <button type="button" className="rama-model-list-showall" onClick={() => setShowAll(false)}>
          show catalog models only
        </button>
      )}

      <div className="rama-provider-settings-input-row">
        <Input placeholder="add model id manually…" value={manualId} onChange={(e) => setManualId(e.target.value)} />
        <Button size="sm" variant="ghost" onClick={handleAddManual} disabled={!manualId.trim() || busyId === manualId.trim()}>
          + add model manually
        </Button>
      </div>
    </div>
  );
}

function ModelRow({
  group,
  providerId,
  busyId,
  onWithBusy,
}: {
  group: ModelGroup;
  providerId: string;
  busyId: string | null;
  onWithBusy: (id: string, fn: () => Promise<unknown>) => Promise<void>;
}) {
  const [showSnapshots, setShowSnapshots] = useState(false);
  const m = group.primary;
  const supersededTarget = m.supersededBy;

  return (
    <div className="rama-model-row-wrap">
      <div className="rama-model-row">
        <Toggle checked={m.enabled} onChange={(v) => onWithBusy(m.id, () => setProviderModelEnabled(providerId, m.id, v))} />
        <span className="rama-model-row-label">{m.label}</span>
        {m.tier && <span className="rama-model-row-tag">{m.tier}</span>}
        {m.pricing && (
          <span className="rama-model-row-tag">
            ${m.pricing.inputPerMillion}/{m.pricing.outputPerMillion} · {m.pricing.source}
          </span>
        )}
        {m.supportsTools && <span className="rama-model-menu-badge">tools</span>}
        {m.supportsThinking && <span className="rama-model-menu-badge">thinking</span>}
        {m.supportsVision && <span className="rama-model-menu-badge">vision</span>}
        <span className="rama-model-row-status">
          {m.status === "erroring" ? (m.lastError ?? "erroring") : m.status}
        </span>
        {group.snapshots.length > 0 && (
          <button type="button" className="rama-model-row-snapshots-toggle" onClick={() => setShowSnapshots((v) => !v)}>
            {group.snapshots.length} snapshot{group.snapshots.length === 1 ? "" : "s"}
          </button>
        )}
        {supersededTarget && (
          <button
            type="button"
            className="rama-model-row-switch"
            disabled={busyId === m.id}
            onClick={() => onWithBusy(m.id, () => switchProviderModel(providerId, m.id, supersededTarget))}
          >
            → {supersededTarget} available
          </button>
        )}
        {m.status === "missing" && (
          <button
            type="button"
            className="rama-model-row-switch"
            disabled={busyId === m.id}
            onClick={() => onWithBusy(m.id, () => removeProviderModel(providerId, m.id))}
          >
            no longer offered — remove?
          </button>
        )}
      </div>
      {showSnapshots &&
        group.snapshots.map((s) => (
          <div key={s.id} className="rama-model-row rama-model-row-snapshot">
            <Toggle checked={s.enabled} onChange={(v) => onWithBusy(s.id, () => setProviderModelEnabled(providerId, s.id, v))} />
            <span className="rama-model-row-label">{s.id}</span>
            <span className="rama-model-row-status">{s.status}</span>
          </div>
        ))}
    </div>
  );
}
