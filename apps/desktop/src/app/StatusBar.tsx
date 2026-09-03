// docs/REDESIGN_PLAN.md Phase R3 — trimmed to branch/diff/running/version; provider health moved
// into the Settings modal's Providers pane (SettingsModal.tsx), and the repo badge/star
// count/license (static marketing chrome, not live app state) moved into its About pane.
export function StatusBar() {
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
      <span className="rama-statusbar-spacer" />
      <span style={{ color: "rgba(var(--ink),0.3)" }}>v0.1.0</span>
    </div>
  );
}
