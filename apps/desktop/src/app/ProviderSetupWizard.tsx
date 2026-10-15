import { useEffect, useRef, useState } from "react";
import { Button, Input, SegmentedControl, Toggle, useToast } from "@rama/ui";
import type { CatalogProviderSummaryDTO, ModelRole, ModelRoleDTO, ProviderDTO } from "@rama/protocol";
import { createCustomProvider, createProvider, fetchCatalogProviders, fetchModelRoles, saveModelRole, updateProviderConfig } from "../engine/client";
import { useProvidersData } from "./data/ProvidersProvider";
import { ModelListSection } from "./ProvidersSettingsPane";

// docs/PROVIDERS_PLAN.md Phase P5 — "the wizard, and custom providers": the full flow for the case
// fast-add can't serve, a provider Rama has never heard of. Inline in the pane, never a nested
// modal (Modal.tsx doesn't stack). Two hosts render this: ProvidersSettingsPane's "+ custom
// provider" tile (skips straight to `credentials` in custom mode — the choice is already implicit
// in which tile was clicked) and the Code landing's no-provider card (starts at `choose`, since
// there's no existing tile grid to have already chosen from).

type WizardStep = "choose" | "credentials" | "verify" | "models" | "finish";
type WizardMode = "catalog" | "custom";
export type WizardChoice = { kind: "catalog"; id: string } | { kind: "custom" };

const STEP_ORDER: WizardStep[] = ["choose", "credentials", "verify", "models", "finish"];

export function ProviderSetupWizard({
  initialChoice,
  onDone,
  onCancel,
}: {
  initialChoice?: WizardChoice;
  onDone: (providerId: string) => void;
  onCancel?: () => void;
}) {
  const { providers, health, saveProviderKey, refreshHealth, reload } = useProvidersData();
  const { push } = useToast();
  const [catalog, setCatalog] = useState<CatalogProviderSummaryDTO[]>([]);
  const [roles, setRoles] = useState<Record<ModelRole, ModelRoleDTO | null> | null>(null);
  const [step, setStep] = useState<WizardStep>(initialChoice ? "credentials" : "choose");
  const [mode, setMode] = useState<WizardMode>(initialChoice?.kind === "custom" ? "custom" : "catalog");
  const [catalogProvider, setCatalogProvider] = useState<CatalogProviderSummaryDTO | undefined>(undefined);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [requiresKey, setRequiresKey] = useState(true);
  const [authStyle, setAuthStyle] = useState<"bearer" | "header">("bearer");
  const [authHeader, setAuthHeader] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [makeDefault, setMakeDefault] = useState<boolean | null>(null);
  const initializedRef = useRef(false);

  useEffect(() => {
    fetchCatalogProviders()
      .then(setCatalog)
      .catch((err) => console.error("[rama] failed to load catalog providers", err));
    fetchModelRoles()
      .then(setRoles)
      .catch((err) => console.error("[rama] failed to load model roles", err));
  }, []);

  const configuredIds = new Set(providers.map((p) => p.id));

  function chooseCatalog(c: CatalogProviderSummaryDTO) {
    setMode("catalog");
    setCatalogProvider(c);
    setBaseUrl(c.baseUrl ?? "");
    setRequiresKey(c.requiresKey);
    setApiKey("");
    setSubmitError(null);
    setStep("credentials");
  }

  function chooseCustom() {
    setMode("custom");
    setCatalogProvider(undefined);
    setLabel("");
    setBaseUrl("");
    setRequiresKey(true);
    setAuthStyle("bearer");
    setAuthHeader("");
    setApiKey("");
    setSubmitError(null);
    setStep("credentials");
  }

  // Resolves initialChoice exactly once. The catalog fetch above is async, so a `catalog` choice
  // waits for it to land before it can find the matching tile.
  useEffect(() => {
    if (!initialChoice || initializedRef.current) return;
    if (initialChoice.kind === "custom") {
      initializedRef.current = true;
      chooseCustom();
      return;
    }
    const match = catalog.find((c) => c.id === initialChoice.id);
    if (match) {
      initializedRef.current = true;
      chooseCatalog(match);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChoice, catalog]);

  async function handleConnect() {
    setBusy(true);
    setSubmitError(null);
    try {
      let dto: ProviderDTO;
      if (mode === "catalog" && catalogProvider) {
        dto = await createProvider(catalogProvider.id);
        if (baseUrl.trim() && baseUrl.trim() !== dto.baseUrl) {
          dto = await updateProviderConfig(dto.id, { baseUrl: baseUrl.trim() });
        }
        if (catalogProvider.requiresKey) await saveProviderKey(dto.id, apiKey.trim());
      } else {
        dto = await createCustomProvider({
          label: label.trim(),
          baseUrl: baseUrl.trim(),
          requiresKey,
          authStyle,
          authHeader: authStyle === "header" ? authHeader.trim() : null,
        });
        if (requiresKey) await saveProviderKey(dto.id, apiKey.trim());
      }
      await reload();
      setProviderId(dto.id);
      setStep("verify");
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // Auto-verify on arrival — "Verify: the existing providerHealth check", run the instant the row
  // exists rather than making the user press a button to find out what "connect" already did.
  useEffect(() => {
    if (step !== "verify" || !providerId) return;
    setVerifying(true);
    refreshHealth(providerId)
      .then(() => reload())
      .finally(() => setVerifying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, providerId]);

  async function handleRecheck() {
    if (!providerId) return;
    setVerifying(true);
    try {
      await refreshHealth(providerId);
      await reload();
    } finally {
      setVerifying(false);
    }
  }

  const provider = providerId ? providers.find((p) => p.id === providerId) : undefined;
  const providerHealth = providerId ? health[providerId] : undefined;
  const providerStatus = providerHealth?.status ?? "checking";
  const hasEnabledModel = provider ? provider.models.some((m) => m.enabled) : false;
  const chatRoleProviderId = roles?.chat?.providerId ?? null;
  const effectiveMakeDefault = makeDefault ?? chatRoleProviderId === null;

  async function handleFinish() {
    if (!provider) return;
    if (effectiveMakeDefault) {
      const firstModel = provider.models.find((m) => m.enabled);
      if (firstModel) {
        try {
          await saveModelRole("chat", provider.id, firstModel.id);
        } catch (err) {
          push(err instanceof Error ? err.message : String(err), "bad");
        }
      }
    }
    push(`${provider.label} connected`, "good");
    onDone(provider.id);
  }

  const canConnect =
    mode === "catalog"
      ? !!catalogProvider && baseUrl.trim().length > 0 && (!catalogProvider.requiresKey || apiKey.trim().length > 0)
      : label.trim().length > 0 &&
        baseUrl.trim().length > 0 &&
        (!requiresKey || apiKey.trim().length > 0) &&
        (authStyle !== "header" || authHeader.trim().length > 0);

  return (
    <div className="rama-wizard">
      <div className="rama-wizard-steps">
        {STEP_ORDER.map((s, i) => (
          <span
            key={s}
            className={
              "rama-wizard-step" +
              (s === step ? " rama-wizard-step-active" : "") +
              (STEP_ORDER.indexOf(step) > i ? " rama-wizard-step-done" : "")
            }
          >
            {i + 1}. {s}
          </span>
        ))}
        {onCancel && (
          <button type="button" className="rama-wizard-cancel" onClick={onCancel}>
            cancel
          </button>
        )}
      </div>

      {step === "choose" && (
        <div className="rama-wizard-body">
          <div className="rama-settings-hint">pick a provider rama already knows, or connect anything OpenAI-compatible.</div>
          <div className="rama-provider-add-tiles">
            {catalog
              .filter((c) => !configuredIds.has(c.id))
              .map((c) => (
                <button type="button" key={c.id} className="rama-provider-add-tile" onClick={() => chooseCatalog(c)}>
                  + {c.label}
                </button>
              ))}
            <button type="button" className="rama-provider-add-tile" onClick={chooseCustom}>
              + custom (OpenAI-compatible)
            </button>
          </div>
        </div>
      )}

      {step === "credentials" && (
        <div className="rama-wizard-body">
          {mode === "custom" ? (
            <>
              <div className="rama-settings-field">
                <label className="rama-settings-label">display label</label>
                <Input placeholder="e.g. Acme Gateway" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
              </div>
              <div className="rama-settings-field">
                <label className="rama-settings-label">base URL</label>
                <Input placeholder="https://gateway.example.com/v1" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </div>
              <div className="rama-settings-field">
                <Toggle checked={requiresKey} onChange={setRequiresKey} label={requiresKey ? "needs a key" : "no key needed"} />
              </div>
              {requiresKey && (
                <>
                  <div className="rama-settings-field">
                    <label className="rama-settings-label">auth style</label>
                    <SegmentedControl
                      options={[
                        { id: "bearer", label: "bearer" },
                        { id: "header", label: "named header" },
                      ]}
                      value={authStyle}
                      onChange={setAuthStyle}
                    />
                    <div className="rama-settings-hint">
                      {authStyle === "bearer" ? "sent as Authorization: Bearer <key>." : "sent under a header name you choose."}
                    </div>
                  </div>
                  {authStyle === "header" && (
                    <div className="rama-settings-field">
                      <label className="rama-settings-label">header name</label>
                      <Input placeholder="x-api-key" value={authHeader} onChange={(e) => setAuthHeader(e.target.value)} />
                    </div>
                  )}
                  <div className="rama-settings-field">
                    <label className="rama-settings-label">API key</label>
                    <Input type="password" placeholder="paste your key…" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                  </div>
                </>
              )}
            </>
          ) : (
            catalogProvider && (
              <>
                <div className="rama-provider-settings-label">{catalogProvider.label}</div>
                <div className="rama-settings-field">
                  <label className="rama-settings-label">base URL</label>
                  <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                </div>
                {catalogProvider.requiresKey && (
                  <div className="rama-settings-field">
                    <label className="rama-settings-label">API key</label>
                    <Input
                      type="password"
                      placeholder="paste your key…"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      autoFocus
                    />
                  </div>
                )}
              </>
            )
          )}

          {submitError && <div className="rama-provider-settings-error">{submitError}</div>}

          <div className="rama-wizard-actions">
            {!initialChoice && (
              <Button size="sm" variant="ghost" onClick={() => setStep("choose")}>
                ‹ back
              </Button>
            )}
            <span style={{ flex: 1 }} />
            <Button size="sm" onClick={handleConnect} disabled={!canConnect || busy}>
              {busy ? "connecting…" : "connect →"}
            </Button>
          </div>
        </div>
      )}

      {step === "verify" && provider && (
        <div className="rama-wizard-body">
          {verifying ? (
            <div className="rama-settings-hint">checking connection…</div>
          ) : providerStatus === "ok" ? (
            <div className="rama-badge rama-badge-good">
              connected{providerHealth?.latencyMs != null ? ` · ${providerHealth.latencyMs}ms` : ""}
            </div>
          ) : (
            <div className="rama-provider-settings-error">{providerHealth?.error ?? "could not reach this provider"}</div>
          )}
          <div className="rama-wizard-actions">
            <Button size="sm" variant="ghost" onClick={() => setStep("credentials")}>
              ‹ back
            </Button>
            <Button size="sm" variant="ghost" onClick={handleRecheck} disabled={verifying}>
              re-check
            </Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" onClick={() => setStep("models")} disabled={verifying}>
              {providerStatus === "ok" ? "continue →" : "save anyway →"}
            </Button>
          </div>
        </div>
      )}

      {step === "models" && provider && (
        <div className="rama-wizard-body">
          <ModelListSection provider={provider} onReload={reload} />
          <div className="rama-wizard-actions">
            <Button size="sm" variant="ghost" onClick={() => setStep("verify")}>
              ‹ back
            </Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" onClick={() => setStep("finish")} disabled={!hasEnabledModel}>
              next →
            </Button>
          </div>
          {!hasEnabledModel && <div className="rama-settings-hint">enable at least one model to continue.</div>}
        </div>
      )}

      {step === "finish" && provider && (
        <div className="rama-wizard-body">
          <div className="rama-settings-field">
            <Toggle checked={effectiveMakeDefault} onChange={setMakeDefault} label="make this the default for new chats" />
            <div className="rama-settings-hint">wires {provider.label} to the "chat" role every new chat starts on.</div>
          </div>
          <div className="rama-wizard-actions">
            <Button size="sm" variant="ghost" onClick={() => setStep("models")}>
              ‹ back
            </Button>
            <span style={{ flex: 1 }} />
            <Button size="sm" onClick={handleFinish}>
              finish
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
