import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useWebviewVisibility } from "../useWebviewVisibility";
import { useWebPane } from "./WebPaneContext";

// docs/MISSION_CONTROL_PLAN.md §4.1 / §8 Phase M5 — toolbar: back / forward / reload / omnibox,
// matching the rail header's 36px band. `containerRef`'s div is a placeholder only — the actual
// content is a native child webview useWebviewVisibility positions on top of it; nothing is ever
// drawn inside this element itself.
export function WebStage() {
  const { active, navigate, reload, goBack, goForward } = useWebPane();
  const containerRef = useRef<HTMLDivElement>(null);
  const [omnibox, setOmnibox] = useState(active?.url ?? "");

  useWebviewVisibility(active?.id ?? null, containerRef);

  useEffect(() => {
    setOmnibox(active?.url ?? "");
  }, [active?.id, active?.url]);

  if (!active) {
    return <div className="rama-mc-coming-soon">no page open — press + to open one.</div>;
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void navigate(omnibox);
  }

  return (
    <>
      <div className="rama-artifact-preview-toolbar">
        <button type="button" className="rama-btn rama-btn-icon" title="Back" onClick={() => void goBack()}>
          ‹
        </button>
        <button type="button" className="rama-btn rama-btn-icon" title="Forward" onClick={() => void goForward()}>
          ›
        </button>
        <button type="button" className="rama-btn rama-btn-icon" title="Reload" onClick={() => void reload()}>
          ⟳
        </button>
        <form onSubmit={submit} style={{ flex: 1, minWidth: 0 }}>
          <input
            className="rama-input"
            style={{ width: "100%" }}
            value={omnibox}
            onChange={(e) => setOmnibox(e.target.value)}
            spellCheck={false}
          />
        </form>
        {active.loading && (
          <span style={{ fontSize: "var(--fs-micro)", color: "rgba(var(--ink),0.4)", flexShrink: 0 }}>loading…</span>
        )}
      </div>
      <div ref={containerRef} className="rama-web-surface" />
    </>
  );
}
