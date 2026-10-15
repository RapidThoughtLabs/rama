import { Empty, tildePath } from "../../code/workspace/parts";
import { XtermSurface } from "../XtermSurface";
import { useTerminalPane } from "./TerminalPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1776-1787) — the Terminal stage bar (title, cwd, Clear,
// Stop) and the xterm surface. Clear needs the live xterm, which the stage owns, so the provider
// holds the ref the two share.

export function TerminalStageBar() {
  const { active, runningIds, killTerminal, termRef } = useTerminalPane();

  if (!active) {
    return (
      <div className="r-stage-title">
        <b>No terminals</b>
      </div>
    );
  }

  const running = runningIds.has(active.id) && active.status === "running";
  const failed = active.status === "exited" && active.exitCode !== null && active.exitCode !== 0;

  return (
    <>
      <div className="r-stage-title">
        <b>{active.title}</b>
        <small>{tildePath(active.cwd)}</small>
        {failed && <small style={{ color: "var(--bad)" }}>exit {active.exitCode}</small>}
      </div>
      <span className="grow" />
      <button className="r-mini" onClick={() => termRef.current?.clear()}>
        Clear
      </button>
      <button className="r-mini" disabled={!running} onClick={() => void killTerminal(active.id)}>
        Stop
      </button>
    </>
  );
}

// `key={active.id}` on XtermSurface is deliberate: switching the selected terminal fully
// unmounts/remounts the xterm instance rather than reusing it, as the old TerminalView did per chat.
export function TerminalStage() {
  const { active, termRef } = useTerminalPane();
  if (!active) return <Empty title="No terminals yet">Open one with the + button, or ask Rama to run something.</Empty>;
  return <XtermSurface key={active.id} terminal={active} onTerminal={(t) => (termRef.current = t)} />;
}
