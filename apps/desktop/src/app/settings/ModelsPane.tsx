import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, placeOf, useToast } from "@rama/ui";
import type { ModelInfo, ModelRole, ModelRoleDTO, ProviderDTO, ProviderHealthDTO } from "@rama/protocol";
import { addProviderModel, fetchModelRoles, removeProviderModel, saveModelRole, setProviderModelEnabled, switchProviderModel } from "../../engine/client";
import { useProvidersData } from "../data/ProvidersProvider";
import { lastViewedAt, markViewed } from "./newModels";
import { Card, PaneHead, Row, Section, Select, StatusDot, errorText } from "./parts";
import type { Navigate } from "./SettingsModal";

/* Settings › Models — the model menu's contents, mixed from any provider. "Your models" is the
   shortlist (provider_models.enabled, docs/PROVIDERS_PLAN.md P4) grouped by provider; "Add models"
   picks a provider and lists what it offers (the roster its health probe fetched), plus an
   add-by-ID field for anything unlisted; "Defaults" assigns the chat and utility roles (P2). */

const CHAT_ONLY_EXCLUDE = /embed|whisper|tts|dall-e|dalle|rerank|moderat|transcri|text-to-speech|speech|image-gen|imagen/i;
const SNAPSHOT = /-(\d{4}-\d{2}-\d{2}|\d{8})$/;
const TIER: Record<string, number> = { frontier: 0, workhorse: 1, small: 2 };
const PAGE = 40;

function ctxLabel(n: number): string | null {
  if (!n) return null;
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}M` : `${Math.round(n / 1000)}k`;
}

function Caps({ m }: { m: ModelInfo }) {
  return (
    <span className="r-model-tags">
      {m.supportsVision && <span className="r-tag">Vision</span>}
      {m.supportsThinking && <span className="r-tag">Thinking</span>}
      {m.supportsTools && <span className="r-tag">Tools</span>}
    </span>
  );
}

export function ModelsPane({ initialProviderId, navigate }: { initialProviderId?: string; navigate: Navigate }) {
  const { providers, health, reload, loading } = useProvidersData();
  const { push } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const addRef = useRef<HTMLDivElement>(null);

  // Arriving from "Choose models" on a provider: its list is what the visit is for.
  useEffect(() => {
    if (initialProviderId) addRef.current?.scrollIntoView({ block: "start" });
  }, [initialProviderId]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch (err) {
      push(errorText(err), "bad");
    } finally {
      setBusy(null);
    }
  }

  const add = (p: ProviderDTO, id: string) => run(`${p.id}/${id}`, () => setProviderModelEnabled(p.id, id, true));
  // A model added by ID that the provider never listed (or one it no longer offers) has nothing to
  // come back to, so its row is deleted. Anything still listed is just switched off.
  const removeFromMenu = (p: ProviderDTO, m: ModelInfo) =>
    run(`${p.id}/${m.id}`, () =>
      (m.addedManually && m.status === "unverified") || m.status === "missing" ? removeProviderModel(p.id, m.id) : setProviderModelEnabled(p.id, m.id, false),
    );

  const mine = providers.map((p) => ({ provider: p, models: p.models.filter((m) => m.enabled) })).filter((g) => g.models.length > 0);
  const total = mine.reduce((n, g) => n + g.models.length, 0);

  if (!loading && providers.length === 0) {
    return (
      <>
        <PaneHead title="Models" sub="Pick the models you want in the model menu, from any of your providers." />
        <div className="r-set-body">
          <Card>
            <div className="r-set-empty">
              <b>Add a provider first</b>
              <p>Models come from providers: an API on this Mac like Ollama, or one in the cloud. Once one is added, its models show up here.</p>
              <button type="button" className="r-btn" onClick={() => navigate("providers", { addProvider: true })}>
                <Icon name="plus" />
                Add provider
              </button>
            </div>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      <PaneHead title="Models" sub="Pick the models you want in the model menu. Mix them from any of your providers." />
      <div className="r-set-body">
        <Section title="In your menu" count={total}>
          <Card>
            {mine.length === 0 ? (
              <div className="r-set-empty">
                <b>No models yet</b>
                <p>Choose a provider below and add the models you want to use.</p>
              </div>
            ) : (
              mine.map(({ provider, models }) => (
                <MineGroup key={provider.id} provider={provider} health={health[provider.id]} models={models} busy={busy} onRemove={(m) => removeFromMenu(provider, m)} onSwitch={(m, to) => run(`${provider.id}/${m.id}`, () => switchProviderModel(provider.id, m.id, to))} />
              ))
            )}
          </Card>
        </Section>

        <div ref={addRef}>
          <AddModels providers={providers} health={health} initialProviderId={initialProviderId} busy={busy} onAdd={add} onRemove={removeFromMenu} onAddById={(p, id) => run(`${p.id}/${id}`, () => addProviderModel(p.id, id))} navigate={navigate} />
        </div>

        {total > 0 && <Defaults providers={providers} />}
      </div>
    </>
  );
}

function MineGroup({
  provider,
  health,
  models,
  busy,
  onRemove,
  onSwitch,
}: {
  provider: ProviderDTO;
  health: ProviderHealthDTO | undefined;
  models: ModelInfo[];
  busy: string | null;
  onRemove: (m: ModelInfo) => void;
  onSwitch: (m: ModelInfo, to: string) => void;
}) {
  const local = placeOf(provider) === "local";
  return (
    <>
      <div className="r-subhead">
        <StatusDot status={health?.status ?? "checking"} />
        <span>{provider.label}</span>
        <Icon name={local ? "lock" : "cloud"} />
      </div>
      {models.map((m) => (
        <div key={m.id} className="r-model">
          <div className="r-model-text">
            <b>{m.label}</b>
            {m.label !== m.id && <code>{m.id}</code>}
          </div>
          {m.status === "missing" && <span className="r-tag bad">No longer offered</span>}
          {m.status === "erroring" && (
            <span className="r-tag bad" title={m.lastError ?? undefined}>
              Failing
            </span>
          )}
          {m.supersededBy && (
            <button type="button" className="r-mini" onClick={() => onSwitch(m, m.supersededBy!)} disabled={busy === `${provider.id}/${m.id}`} title={`Switch to ${m.supersededBy}`}>
              Newer version
              <Icon name="right" />
            </button>
          )}
          <Caps m={m} />
          <span className="r-model-ctx">{ctxLabel(m.contextWindow)}</span>
          <button
            type="button"
            className="r-icon-btn"
            aria-label={`Remove ${m.label} from your menu`}
            title="Remove from your menu"
            disabled={busy === `${provider.id}/${m.id}`}
            onClick={() => onRemove(m)}
          >
            <Icon name="x" />
          </button>
        </div>
      ))}
    </>
  );
}

interface Group {
  primary: ModelInfo;
  dated: ModelInfo[];
}

function groupRoster(models: ModelInfo[]): Group[] {
  const byBase = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const base = m.id.replace(SNAPSHOT, "");
    byBase.set(base, [...(byBase.get(base) ?? []), m]);
  }
  const groups = [...byBase.entries()].map(([base, members]) => {
    const sorted = [...members].sort((a, b) => (a.id === base ? -1 : b.id === base ? 1 : b.firstSeenAt - a.firstSeenAt));
    return { primary: sorted[0]!, dated: sorted.slice(1) };
  });
  return groups.sort((a, b) => {
    const ta = a.primary.inCatalog ? (TIER[a.primary.tier ?? ""] ?? 3) : 4;
    const tb = b.primary.inCatalog ? (TIER[b.primary.tier ?? ""] ?? 3) : 4;
    return ta - tb || a.primary.label.localeCompare(b.primary.label, undefined, { numeric: true });
  });
}

function AddModels({
  providers,
  health,
  initialProviderId,
  busy,
  onAdd,
  onRemove,
  onAddById,
  navigate,
}: {
  providers: ProviderDTO[];
  health: Record<string, ProviderHealthDTO>;
  initialProviderId?: string;
  busy: string | null;
  onAdd: (p: ProviderDTO, id: string) => void;
  onRemove: (p: ProviderDTO, m: ModelInfo) => void;
  onAddById: (p: ProviderDTO, id: string) => void;
  navigate: Navigate;
}) {
  const [selectedId, setSelectedId] = useState(() => (providers.some((p) => p.id === initialProviderId) ? initialProviderId! : providers[0]?.id));
  const [query, setQuery] = useState("");
  const [chatOnly, setChatOnly] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [byId, setById] = useState("");
  const provider = providers.find((p) => p.id === selectedId) ?? providers[0];

  // "New" is relative to the last visit, so read the bookmark once per provider, then move it.
  const since = useMemo(() => (provider ? lastViewedAt(provider.id) : 0), [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!provider) return;
    setShowAll(false);
    setQuery("");
    return () => markViewed(provider.id);
  }, [provider?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!provider) return null;
  const status = health[provider.id]?.status ?? "checking";
  const error = health[provider.id]?.error;

  const q = query.trim().toLowerCase();
  const listed = provider.models.filter(
    (m) => m.status !== "missing" && (!chatOnly || (!CHAT_ONLY_EXCLUDE.test(m.id) && !CHAT_ONLY_EXCLUDE.test(m.label))) && (!q || m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)),
  );
  const groups = groupRoster(listed);
  const visible = showAll || q ? groups : groups.slice(0, PAGE);
  const rosterEmpty = provider.models.filter((m) => !m.addedManually || m.status !== "unverified").length === 0;

  function submitById() {
    const id = byId.trim();
    if (!id) return;
    onAddById(provider!, id);
    setById("");
  }

  return (
    <Section title="Add models">
      <div className="r-chips" role="group" aria-label="Provider">
        {providers.map((p) => (
          <button key={p.id} type="button" className="r-chip" aria-pressed={p.id === provider.id} onClick={() => setSelectedId(p.id)}>
            <StatusDot status={health[p.id]?.status ?? "checking"} />
            {p.label}
          </button>
        ))}
      </div>
      <Card>
        {status === "bad" && (
          <div className="r-set-notice bad">
            <span>
              Rama can't reach {provider.label}{error ? `: ${error}` : ""}. Its list may be out of date.
            </span>
            <button type="button" className="r-mini" onClick={() => navigate("providers", { providerId: provider.id })}>
              Check provider
            </button>
          </div>
        )}
        {status === "no-key" && (
          <div className="r-set-notice">
            <span>Add an API key to see what {provider.label} offers.</span>
            <button type="button" className="r-mini" onClick={() => navigate("providers", { providerId: provider.id })}>
              Add key
            </button>
          </div>
        )}

        {!rosterEmpty && (
          <div className="r-roster-bar">
            <div className="r-input-search">
              <Icon name="search" />
              <input className="r-input" placeholder={`Search ${provider.models.length} models from ${provider.label}`} value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <label>
              <button type="button" role="switch" className="r-switch" aria-checked={chatOnly} onClick={() => setChatOnly((v) => !v)} aria-label="Chat models only" />
              Chat models only
            </label>
          </div>
        )}

        {rosterEmpty && status === "ok" && (
          <div className="r-set-empty">
            <b>{provider.label} doesn't list its models</b>
            <p>Add the ones you want by their ID below, exactly as the provider's docs spell it.</p>
          </div>
        )}
        {!rosterEmpty && groups.length === 0 && (
          <div className="r-set-empty">
            <p>No models match{q ? ` "${query.trim()}"` : ""}.</p>
          </div>
        )}

        {visible.map((g) => (
          <RosterGroup key={g.primary.id} group={g} provider={provider} since={since} busy={busy} onAdd={onAdd} onRemove={onRemove} />
        ))}

        {!showAll && !q && groups.length > PAGE && (
          <div className="r-roster-more">
            <button type="button" className="r-mini" onClick={() => setShowAll(true)}>
              Show all {groups.length}
            </button>
          </div>
        )}

        <form
          className="r-roster-foot"
          onSubmit={(e) => {
            e.preventDefault();
            submitById();
          }}
        >
          <span>Add by ID</span>
          <input className="r-input mono" spellCheck={false} placeholder={provider.kind === "anthropic" ? "claude-sonnet-5" : "e.g. qwen3:14b"} value={byId} onChange={(e) => setById(e.target.value)} />
          <button type="submit" className="r-btn r-btn-ghost" disabled={!byId.trim()}>
            Add
          </button>
        </form>
      </Card>
    </Section>
  );
}

function RosterGroup({
  group,
  provider,
  since,
  busy,
  onAdd,
  onRemove,
}: {
  group: Group;
  provider: ProviderDTO;
  since: number;
  busy: string | null;
  onAdd: (p: ProviderDTO, id: string) => void;
  onRemove: (p: ProviderDTO, m: ModelInfo) => void;
}) {
  const [open, setOpen] = useState(false);
  const row = (m: ModelInfo, sub: boolean) => (
    <div key={m.id} className={sub ? "r-model sub" : "r-model"}>
      <div className="r-model-text">
        <b>{sub ? m.id : m.label}</b>
        {!sub && m.label !== m.id && <code>{m.id}</code>}
      </div>
      {!m.enabled && m.firstSeenAt > since && <span className="r-tag accent">New</span>}
      {!sub && group.dated.length > 0 && (
        <button type="button" className="r-mini" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {group.dated.length} dated
        </button>
      )}
      <Caps m={m} />
      <span className="r-model-ctx">{ctxLabel(m.contextWindow)}</span>
      <button
        type="button"
        className="r-mini r-model-add"
        aria-pressed={m.enabled}
        disabled={busy === `${provider.id}/${m.id}`}
        title={m.enabled ? "In your menu. Click to remove" : undefined}
        onClick={() => (m.enabled ? onRemove(provider, m) : onAdd(provider, m.id))}
      >
        <Icon name={m.enabled ? "check" : "plus"} />
        {m.enabled ? "Added" : "Add"}
      </button>
    </div>
  );
  return (
    <>
      {row(group.primary, false)}
      {open && group.dated.map((m) => row(m, true))}
    </>
  );
}

const ROLE_COPY: Record<"chat" | "utility", { title: string; hint: (via: string | null, local: boolean) => string }> = {
  chat: { title: "New chats start with", hint: () => "Each chat can still switch models from its model menu." },
  utility: {
    title: "Background tasks",
    hint: (via, local) =>
      `Names your chats and does other small jobs. A fast, cheap model is best.${via ? (local ? " Runs on this Mac." : ` Your first message in each chat is sent to ${via}.`) : ""}`,
  },
};

function Defaults({ providers }: { providers: ProviderDTO[] }) {
  const [roles, setRoles] = useState<Record<ModelRole, ModelRoleDTO | null> | null>(null);
  const { push } = useToast();

  useEffect(() => {
    fetchModelRoles()
      .then(setRoles)
      .catch((err) => console.error("[rama] failed to load model roles", err));
  }, [providers]);

  async function assign(role: "chat" | "utility", value: string) {
    const [providerId, modelId] = value.split("\u0000") as [string, string];
    setRoles((prev) => (prev ? { ...prev, [role]: { role, providerId, modelId, updatedAt: Date.now() } } : prev));
    try {
      await saveModelRole(role, providerId, modelId);
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  if (!roles) return null;
  const usable = providers
    .map((p) => ({ p, models: p.models.filter((m) => m.enabled && m.status !== "missing" && m.status !== "erroring") }))
    .filter((g) => g.models.length > 0);

  return (
    <Section title="Defaults">
      <Card>
        {(["chat", "utility"] as const).map((role) => {
          const cur = roles[role];
          const value = cur ? `${cur.providerId}\u0000${cur.modelId}` : "";
          const listed = usable.some((g) => g.p.id === cur?.providerId && g.models.some((m) => m.id === cur?.modelId));
          const p = cur ? providers.find((x) => x.id === cur.providerId) : undefined;
          return (
            <Row key={role} title={ROLE_COPY[role].title} hint={ROLE_COPY[role].hint(p?.label ?? null, !!p && placeOf(p) === "local")}>
              <Select value={value} onChange={(e) => void assign(role, e.target.value)} aria-label={ROLE_COPY[role].title}>
                {!cur && <option value="">Choose a model</option>}
                {cur && !listed && (
                  <option value={value}>
                    {cur.modelId} (not in your menu)
                  </option>
                )}
                {usable.map(({ p: prov, models }) => (
                  <optgroup key={prov.id} label={prov.label}>
                    {models.map((m) => (
                      <option key={m.id} value={`${prov.id}\u0000${m.id}`}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </Select>
            </Row>
          );
        })}
      </Card>
    </Section>
  );
}
