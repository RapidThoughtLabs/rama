import { useEffect, useRef, useState } from "react";
import { Icon } from "@rama/ui";
import type { ProviderHealthDTO, ProviderKind } from "@rama/protocol";
import { createCustomProvider, fetchProviderHealth } from "../../engine/client";
import { useProvidersData } from "../data/ProvidersProvider";
import { SPECS, suggestName, validBaseUrl } from "./endpoint";
import { markViewed } from "./newModels";
import { MiniSeg, StatusDot, errorText } from "./parts";

/* Adding a provider: pick the wire format, give a base URL and (optionally) a key. Nothing is
   predefined — the old catalog tiles are gone — though a known endpoint still resolves to its
   catalog entry engine-side, for pricing and caching. The form connects, checks the endpoint, and
   then hands over to Settings › Models, where the provider's models get picked. Replaces
   ProviderSetupWizard's five steps (docs/PROVIDERS_PLAN.md P5). */

type Added = { id: string; label: string; health: ProviderHealthDTO | null };

export function AddProviderForm({
  onCancel,
  onChooseModels,
  onShowProvider,
  cancelLabel = "Cancel",
}: {
  onCancel: () => void;
  onChooseModels: (providerId: string) => void;
  onShowProvider: (providerId: string) => void;
  cancelLabel?: string;
}) {
  const { providers, saveProviderKey, reload } = useProvidersData();
  const [kind, setKind] = useState<ProviderKind>("openai-compatible");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [authStyle, setAuthStyle] = useState<"bearer" | "header">("bearer");
  const [authHeader, setAuthHeader] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Added | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);

  // The result is much shorter than the form it replaces; keep it on screen.
  useEffect(() => {
    if (added) doneRef.current?.scrollIntoView({ block: "nearest" });
  }, [added]);

  const spec = SPECS.find((s) => s.id === kind)!;
  const suggested = suggestName(baseUrl);
  const urlOk = validBaseUrl(baseUrl);
  const headerAuth = kind === "openai-compatible" && authStyle === "header";
  const ready = urlOk && (name.trim() || suggested) && (!headerAuth || authHeader.trim());

  async function submit() {
    if (!ready || busy) return;
    const label = name.trim() || suggested;
    const key = apiKey.trim();
    setBusy(true);
    setError(null);
    let id: string | null = null;
    try {
      const dto = await createCustomProvider({
        kind,
        label,
        baseUrl: baseUrl.trim(),
        requiresKey: key.length > 0,
        authStyle: headerAuth ? "header" : "bearer",
        authHeader: headerAuth ? authHeader.trim() : null,
      });
      id = dto.id;
      if (key) await saveProviderKey(dto.id, key);
      // The health probe is also what fetches the model list, so reload after it.
      const health = await fetchProviderHealth(dto.id).catch(() => null);
      await reload();
      markViewed(dto.id);
      setAdded({ id: dto.id, label, health });
    } catch (err) {
      if (id) {
        await reload().catch(() => {});
        setAdded({ id, label, health: { providerId: id, status: "bad", latencyMs: null, error: errorText(err), checkedAt: Date.now() } });
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  }

  if (added) {
    const ok = added.health?.status === "ok";
    const count = providers.find((p) => p.id === added.id)?.models.length ?? 0;
    return (
      <div className="r-add" ref={doneRef}>
        <div className="r-add-done">
          <StatusDot status={added.health?.status ?? "checking"} />
          <div>
            <b>{ok ? `Connected to ${added.label}` : `Added ${added.label}, but Rama couldn't connect`}</b>
            <p>
              {ok
                ? count > 0
                  ? `It offers ${count} model${count === 1 ? "" : "s"}. Pick the ones you want in your menu.`
                  : "It doesn't list its models, so add them by ID."
                : `${added.health?.error ?? "No response"}. Check the base URL and key.`}
            </p>
          </div>
        </div>
        <div className="r-set-actions">
          {!ok && (
            <button type="button" className="r-btn r-btn-ghost" onClick={() => onShowProvider(added.id)}>
              Check details
            </button>
          )}
          <span className="grow" />
          <button type="button" className="r-btn" onClick={() => onChooseModels(added.id)}>
            Choose models
            <Icon name="right" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="r-add"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>Add a provider</h3>
      <div className="r-specs" role="radiogroup" aria-label="API format">
        {SPECS.map((s) => (
          <button key={s.id} type="button" role="radio" className="r-spec" aria-checked={kind === s.id} onClick={() => setKind(s.id)}>
            <b>
              {s.title}
              <Icon name="check" />
            </b>
            <span>{s.detail}</span>
            <code>{s.wire}</code>
          </button>
        ))}
      </div>

      <div className="r-set-field">
        <label htmlFor="prov-url">Base URL</label>
        <input
          id="prov-url"
          className="r-input mono"
          spellCheck={false}
          autoFocus
          placeholder={spec.urlPlaceholder}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <p>{baseUrl.trim() && !urlOk ? "Start with http:// or https://." : spec.urlHint}</p>
      </div>

      <div className="r-set-fields two">
        <div className="r-set-field">
          <label htmlFor="prov-name">Name</label>
          <input id="prov-name" className="r-input" placeholder={suggested || "e.g. My gateway"} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="r-set-field">
          <label htmlFor="prov-key">API key</label>
          <input
            id="prov-key"
            className="r-input mono"
            type="password"
            autoComplete="off"
            placeholder="Optional for local servers"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
        </div>
      </div>
      <p className="r-set-note" style={{ marginTop: -8 }}>
        Keys are kept in your macOS Keychain, never in Rama's files.
      </p>

      {kind === "openai-compatible" && (
        <>
          <button type="button" className="r-mini r-adv-toggle" aria-expanded={advanced} onClick={() => setAdvanced((v) => !v)}>
            <Icon name="right" />
            How the key is sent
          </button>
          {advanced && (
            <div className="r-set-fields two">
              <div className="r-set-field">
                <span className="lbl">Send the key as</span>
                <MiniSeg
                  label="Send the key as"
                  options={[
                    { id: "bearer", label: "Bearer token" },
                    { id: "header", label: "Custom header" },
                  ]}
                  value={authStyle}
                  onChange={setAuthStyle}
                />
              </div>
              {authStyle === "header" && (
                <div className="r-set-field">
                  <label htmlFor="prov-header">Header name</label>
                  <input id="prov-header" className="r-input mono" spellCheck={false} placeholder="x-api-key" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
                </div>
              )}
            </div>
          )}
        </>
      )}

      {error && <div className="r-set-error">{error}</div>}
      <div className="r-set-actions">
        <span className="grow" />
        <button type="button" className="r-btn r-btn-ghost" onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="submit" className="r-btn" disabled={!ready || busy}>
          {busy ? "Connecting…" : "Add provider"}
        </button>
      </div>
    </form>
  );
}
