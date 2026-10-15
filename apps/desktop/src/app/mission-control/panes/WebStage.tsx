import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Icon } from "@rama/ui";
import { Empty } from "../../code/workspace/parts";
import { useWebviewVisibility } from "../useWebviewVisibility";
import { displayUrl } from "./WebRail";
import { useWebPane } from "./WebPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1788-1796) — the Web stage bar (back, forward, reload, the
// address pill, open in your browser) and the page card the native webview is laid over.

export function WebStageBar() {
  const { active, navigate, reload, goBack, goForward } = useWebPane();
  const [omnibox, setOmnibox] = useState(displayUrl(active?.url ?? ""));

  useEffect(() => {
    setOmnibox(displayUrl(active?.url ?? ""));
  }, [active?.id, active?.url]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (omnibox.trim()) void navigate(omnibox);
  }

  return (
    <>
      <button className="r-icon-btn" title="Back" aria-label="Back" disabled={!active} onClick={() => void goBack()}>
        <Icon name="left" />
      </button>
      <button className="r-icon-btn" title="Forward" aria-label="Forward" disabled={!active} onClick={() => void goForward()}>
        <Icon name="right" />
      </button>
      <button className="r-icon-btn" title="Reload" aria-label="Reload" disabled={!active} onClick={() => void reload()}>
        <Icon name="retry" />
      </button>
      <form className="r-urlbar" onSubmit={submit}>
        <Icon name="globe" />
        <input value={omnibox} onChange={(e) => setOmnibox(e.target.value)} disabled={!active} spellCheck={false} aria-label="Address" placeholder="Search or enter an address" />
        {active?.loading && <span className="spin" aria-label="Loading" />}
      </form>
      <button
        className="r-icon-btn"
        title="Open in your browser"
        aria-label="Open in your browser"
        disabled={!active || active.url === "about:blank"}
        onClick={() => active && void openUrl(active.url).catch((err) => console.error("[rama] failed to open in browser", err))}
      >
        <Icon name="pop" />
      </button>
    </>
  );
}

// `cardRef`'s div is a placeholder only — the content is a native child webview that
// useWebviewVisibility positions over it; nothing is drawn inside the element itself. The card (not
// the stage) is what gets measured, so the webview sits inside the card's margin and shadow.
export function WebStage() {
  const { active } = useWebPane();
  const cardRef = useRef<HTMLDivElement>(null);

  useWebviewVisibility(active?.id ?? null, cardRef);

  if (!active) return <Empty title="No page open">Press + to open one, or ask Rama to look something up.</Empty>;
  return <div ref={cardRef} className="r-page" data-pixel-mask />;
}
