import { useProvidersData } from "./data/ProvidersProvider";
import { useSettingsLink } from "./data/SettingsLinkContext";

// docs/REDESIGN_PLAN.md Phase R3 — trimmed to branch/diff/running/version; provider health moved
// into the Settings modal's Providers pane (SettingsModal.tsx), and the repo badge/star
// count/license (static marketing chrome, not live app state) moved into its About pane.
//
// docs/PROVIDERS_PLAN.md Phase P1 — "the status-bar dot is not polish — without it, a dead key is
// invisible." Hiding a broken provider from the composer picker removes the only place the user
// would have otherwise noticed it broke, so this has to ship in the same phase, not later.
export function StatusBar() {
  const { providers, health } = useProvidersData();
  const { open: openSettings } = useSettingsLink();
  const badProviders = providers.filter((p) => health[p.id]?.status === "bad");

  return (
    <div className="rama-statusbar">
      <span>⑂ main</span>
      <span>
        <span style={{ color: "var(--good)" }}>+48</span> <span style={{ color: "var(--bad)" }}>−12</span>
      </span>
      <span className="rama-conn-pill" style={{ color: "var(--accent-bright, var(--accent))" }}>
        <span className="rama-statusbar-dot" style={{ background: "var(--accent)", boxShadow: "0 0 7px var(--a70)", animation: "pulse 1.3s ease-in-out infinite" }} />
        1 running
      </span>
      {badProviders.length > 0 && (
        <button
          type="button"
          className="rama-statusbar-alert"
          onClick={() => openSettings({ pane: "providers", providerId: badProviders[0].id })}
        >
          <span className="rama-statusbar-dot" style={{ background: "var(--bad)" }} />
          {badProviders.length === 1 ? `${badProviders[0].label} unavailable` : `${badProviders.length} providers unavailable`}
        </button>
      )}
      <span className="rama-statusbar-spacer" />
      <span style={{ color: "rgba(var(--ink),0.3)" }}>v0.1.0</span>
    </div>
  );
}
