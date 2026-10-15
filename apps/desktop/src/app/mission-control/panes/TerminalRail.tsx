import { Icon } from "@rama/ui";
import type { TerminalDTO } from "@rama/protocol";
import { Empty, PressRow, useNow } from "../../code/workspace/parts";
import { useProjectsData } from "../../data/ProjectsProvider";
import { terminalLastActivity } from "../useTerminalSession";
import { useTerminalPane } from "./TerminalPaneContext";

// docs/CODE_REDESIGN_PLAN.md CR4 (mock:L1776-1787) — the Terminal rail head and rail. Each terminal
// is a status dot, its title and one line saying what it is doing and who started it.

/** A running shell that has printed nothing for this long reads as idle (plan CR4; the protocol only
 *  knows running or exited, so quiet is the closest honest signal). */
const IDLE_AFTER_MS = 60_000;

type Dot = "run" | "idle" | "done";

export function TerminalRailHead() {
  const { activeProjectId } = useProjectsData();
  const { createTerminal } = useTerminalPane();
  return (
    <>
      <b className="grow">Terminals</b>
      <button className="r-icon-btn" title="New terminal (⌘⇧`)" aria-label="New terminal" disabled={!activeProjectId} onClick={() => void createTerminal()}>
        <Icon name="plus" />
      </button>
    </>
  );
}

function describe(t: TerminalDTO, running: boolean, now: number): { dot: Dot; sub: string } {
  const by = t.owner === "agent" ? "Rama" : "you";
  if (t.status === "exited") {
    return { dot: "done", sub: t.exitCode === 0 || t.exitCode === null ? `Finished, started by ${by}` : `Exited with code ${t.exitCode}, started by ${by}` };
  }
  // The row says running but nothing in this app owns the process: the app restarted since (§8 M3).
  if (!running) return { dot: "done", sub: "Ended when the app restarted" };
  if (now - terminalLastActivity(t) > IDLE_AFTER_MS) return { dot: "idle", sub: "Idle" };
  return { dot: "run", sub: `Running, started by ${by}` };
}

export function TerminalRail({ collapsed }: { collapsed: boolean }) {
  const { terminals, activeId, setActiveId, runningIds, killTerminal, removeTerminal } = useTerminalPane();
  const now = useNow(15_000);

  async function closeTerminal(t: TerminalDTO) {
    // A still-running shell has to be killed before its row can go away — deleting the DB row
    // out from under a live PTY would just leave it running with nothing referencing it.
    if (runningIds.has(t.id)) await killTerminal(t.id);
    await removeTerminal(t.id);
  }

  if (terminals.length === 0) return collapsed ? null : <Empty compact title="No terminals yet" />;

  return (
    <>
      {terminals.map((t) => {
        const { dot, sub } = describe(t, runningIds.has(t.id), now);
        return (
          <PressRow key={t.id} className="r-rrow" aria-current={t.id === activeId} title={t.title} onPress={() => setActiveId(t.id)}>
            <span className={`r-sdot ${dot}`} />
            <span className="t">{t.title}</span>
            <span className="end" />
            <span className="sub">{sub}</span>
            <button
              className="row-x"
              title="Close terminal"
              aria-label={`Close ${t.title}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeTerminal(t);
              }}
            >
              <Icon name="x" />
            </button>
          </PressRow>
        );
      })}
    </>
  );
}
