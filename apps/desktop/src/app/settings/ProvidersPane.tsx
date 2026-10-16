import { useEffect, useRef, useState } from "react";
import { ConfirmDialog, Icon, placeOf, useToast } from "@rama/ui";
import type { ProviderDTO, ProviderHealthDTO } from "@rama/protocol";
import { deleteProviderKey, removeProvider, updateProviderConfig } from "../../engine/client";
import { useProvidersData } from "../data/ProvidersProvider";
import { AddProviderForm } from "./AddProviderForm";
import { SPEC_LABEL, validBaseUrl } from "./endpoint";
import { Card, PaneHead, STATUS_TEXT, Section, StatusDot, errorText } from "./parts";
import type { Navigate } from "./SettingsModal";

/* Settings › Providers — the services models come from. Each one is an API endpoint the user
   added (OpenAI- or Claude-compatible, any base URL); its row opens into its details. Picking
   models happens in Settings › Models. */

export function ProvidersPane({ focusProviderId, startAdding, navigate }: { focusProviderId?: string; startAdding?: boolean; navigate: Navigate }) {
  const { providers, health, loading } = useProvidersData();
  // null = not decided by the user yet: the form shows by itself while there's no provider at all.
  const [adding, setAdding] = useState<boolean | null>(startAdding ? true : null);
  const [openId, setOpenId] = useState<string | null>(focusProviderId ?? null);
  const empty = !loading && providers.length === 0;
  const showForm = adding ?? empty;

  return (
    <>
      <PaneHead
        title="Providers"
        sub="The services that run your models. Add any API that speaks the OpenAI or Claude format, on this Mac or in the cloud."
        action={
          !showForm &&
          !empty && (
            <button type="button" className="r-btn" onClick={() => setAdding(true)}>
              <Icon name="plus" />
              Add provider
            </button>
          )
        }
      />
      <div className="r-set-body">
        {showForm && (
          <Section>
            <Card>
              <AddProviderForm
                cancelLabel={empty ? "Not now" : "Cancel"}
                onCancel={() => setAdding(false)}
                onChooseModels={(id) => navigate("models", { providerId: id })}
                onShowProvider={(id) => {
                  setAdding(false);
                  setOpenId(id);
                }}
              />
            </Card>
          </Section>
        )}

        {empty && !showForm && (
          <Card>
            <div className="r-set-empty">
              <b>No providers yet</b>
              <p>Rama needs one to run models: a server on this Mac like Ollama or LM Studio, or a cloud API with a key.</p>
              <button type="button" className="r-btn" onClick={() => setAdding(true)}>
                <Icon name="plus" />
                Add provider
              </button>
            </div>
          </Card>
        )}

        {providers.length > 0 && (
          <Section title="Your providers" count={providers.length}>
            <Card>
              {providers.map((p) => (
                <ProviderItem
                  key={p.id}
                  provider={p}
                  health={health[p.id]}
                  open={openId === p.id}
                  focused={focusProviderId === p.id}
                  onToggle={() => setOpenId((cur) => (cur === p.id ? null : p.id))}
                  onChooseModels={() => navigate("models", { providerId: p.id })}
                />
              ))}
            </Card>
          </Section>
        )}
      </div>
    </>
  );
}

function ProviderItem({
  provider,
  health,
  open,
  focused,
  onToggle,
  onChooseModels,
}: {
  provider: ProviderDTO;
  health: ProviderHealthDTO | undefined;
  open: boolean;
  focused: boolean;
  onToggle: () => void;
  onChooseModels: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const status = health?.status ?? "checking";
  const local = placeOf(provider) === "local";
  const enabled = provider.models.filter((m) => m.enabled).length;
  const showError = status === "bad" && health?.error;

  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <div ref={ref} className="r-prov" data-open={open} data-focus={focused}>
      <button type="button" className="r-prov-head" aria-expanded={open} onClick={onToggle}>
        <StatusDot status={status} />
        <span style={{ minWidth: 0 }}>
          <span className="r-prov-name">
            <b>{provider.label}</b>
          </span>
          <span className="r-prov-meta">
            <span className="r-tag">{SPEC_LABEL[provider.kind]}</span>
            <Icon name={local ? "lock" : "cloud"} />
            <span>{local ? "This Mac" : "Cloud"}</span>
            <span aria-hidden="true">·</span>
            <span className="r-prov-url">{provider.baseUrl ?? "https://api.anthropic.com"}</span>
          </span>
        </span>
        <span className="r-prov-count">{enabled === 0 ? "No models yet" : `${enabled} model${enabled === 1 ? "" : "s"}`}</span>
        <Icon name="right" className="r-prov-chev" />
      </button>
      {!open && showError && (
        <div className="r-prov-err r-set-error">
          {STATUS_TEXT.bad}: {health!.error}
        </div>
      )}
      {open && <ProviderDetails provider={provider} health={health} onChooseModels={onChooseModels} />}
    </div>
  );
}

function ProviderDetails({ provider, health, onChooseModels }: { provider: ProviderDTO; health: ProviderHealthDTO | undefined; onChooseModels: () => void }) {
  const { saveProviderKey, refreshHealth, reload } = useProvidersData();
  const { push } = useToast();
  const [label, setLabel] = useState(provider.label);
  const [url, setUrl] = useState(provider.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = health?.status ?? "checking";

  async function recheck() {
    setChecking(true);
    try {
      await refreshHealth(provider.id);
      await reload();
    } finally {
      setChecking(false);
    }
  }

  async function saveLabel() {
    const next = label.trim();
    if (!next || next === provider.label) return setLabel(provider.label);
    try {
      await updateProviderConfig(provider.id, { label: next });
      await reload();
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  async function saveUrl() {
    const next = url.trim();
    if (next === (provider.baseUrl ?? "")) return;
    if (!validBaseUrl(next)) {
      push("A base URL starts with http:// or https://", "bad");
      return setUrl(provider.baseUrl ?? "");
    }
    try {
      const dto = await updateProviderConfig(provider.id, { baseUrl: next });
      setUrl(dto.baseUrl ?? next);
      await recheck();
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  async function saveKey() {
    const next = key.trim();
    if (!next) return;
    setSavingKey(true);
    try {
      // A provider added without a key (a local server) that now gets one starts sending it.
      if (!provider.requiresKey) await updateProviderConfig(provider.id, { requiresKey: true });
      await saveProviderKey(provider.id, next);
      setKey("");
      push(`Saved the ${provider.label} key`, "good");
    } catch (err) {
      push(errorText(err), "bad");
    } finally {
      setSavingKey(false);
    }
  }

  async function remove() {
    setConfirmRemove(false);
    try {
      await removeProvider(provider.id);
      await deleteProviderKey(provider.id).catch(() => {});
      await reload();
      push(`Removed ${provider.label}`, "good");
    } catch (err) {
      push(errorText(err), "bad");
    }
  }

  const keyPlaceholder = !provider.requiresKey
    ? "Not needed. Paste one if the server asks"
    : status === "no-key"
      ? "Paste your API key"
      : "Saved in your Keychain. Paste a new one to replace it";

  return (
    <div className="r-prov-body">
      <div className="r-prov-status">
        <StatusDot status={status} />
        <span>
          {STATUS_TEXT[status]}
          {status === "ok" && health?.latencyMs != null && ` · ${health.latencyMs} ms`}
          {status === "bad" && health?.error && `: ${health.error}`}
        </span>
        <button type="button" className="r-mini" onClick={() => void recheck()} disabled={checking}>
          <Icon name="retry" />
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>

      <div className="r-set-fields two">
        <div className="r-set-field">
          <label htmlFor={`pv-name-${provider.id}`}>Name</label>
          <input id={`pv-name-${provider.id}`} className="r-input" value={label} onChange={(e) => setLabel(e.target.value)} onBlur={() => void saveLabel()} />
        </div>
        <div className="r-set-field">
          <span className="lbl">API format</span>
          <input className="r-input" value={SPEC_LABEL[provider.kind]} readOnly tabIndex={-1} style={{ color: "var(--ink-3)" }} />
        </div>
      </div>
      <div className="r-set-field">
        <label htmlFor={`pv-url-${provider.id}`}>Base URL</label>
        <input
          id={`pv-url-${provider.id}`}
          className="r-input mono"
          spellCheck={false}
          placeholder={provider.kind === "anthropic" ? "https://api.anthropic.com" : "https://…/v1"}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => void saveUrl()}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="r-set-field">
        <label htmlFor={`pv-key-${provider.id}`}>API key</label>
        <div className="r-set-inline">
          <input
            id={`pv-key-${provider.id}`}
            className="r-input mono"
            type="password"
            autoComplete="off"
            placeholder={keyPlaceholder}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveKey()}
          />
          {key.trim() && (
            <button type="button" className="r-btn" onClick={() => void saveKey()} disabled={savingKey}>
              {savingKey ? "Saving…" : "Save key"}
            </button>
          )}
        </div>
      </div>

      <div className="r-set-actions">
        <button type="button" className="r-btn r-btn-soft" onClick={onChooseModels}>
          <Icon name="chip" />
          Choose models
        </button>
        <span className="grow" />
        <button type="button" className="r-mini danger" onClick={() => setConfirmRemove(true)}>
          Remove provider
        </button>
      </div>

      <ConfirmDialog
        open={confirmRemove}
        title={`Remove ${provider.label}?`}
        confirmLabel="Remove"
        danger
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      >
        Its models leave the menu and its key is deleted from your Keychain. Chats that used it keep their history.
      </ConfirmDialog>
    </div>
  );
}
