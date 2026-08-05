import type { ProviderHealthStatus } from "@rama/protocol";
import { useProvidersData } from "./data/ProvidersProvider";

const STATUS_COLOR: Record<ProviderHealthStatus, string> = {
  ok: "var(--good)",
  bad: "var(--bad)",
  "no-key": "var(--warn)",
  checking: "var(--warn)",
};

const STATUS_SUFFIX: Record<ProviderHealthStatus, string> = {
  ok: "",
  bad: " · error",
  "no-key": " · no key",
  checking: " · checking",
};

export function StatusBar() {
  const { providers, health } = useProvidersData();

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
      <span style={{ opacity: 0.4 }}>│</span>
      {providers.map((p) => {
        const status = health[p.id]?.status ?? "checking";
        return (
          <span key={p.id} className="rama-conn-pill" title={health[p.id]?.error ?? undefined}>
            <span className="rama-statusbar-dot" style={{ background: STATUS_COLOR[status] }} />
            {p.label.toLowerCase()}
            {STATUS_SUFFIX[status]}
          </span>
        );
      })}
      <span className="rama-statusbar-spacer" />
      <span>◇ rtl-labs/rama</span>
      <span>★ 12.4k</span>
      <span>MIT</span>
      <span style={{ color: "rgba(var(--ink),0.3)" }}>v0.1.0</span>
    </div>
  );
}
