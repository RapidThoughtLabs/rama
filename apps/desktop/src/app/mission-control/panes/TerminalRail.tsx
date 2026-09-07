import type { TerminalDTO } from "@rama/protocol";
import { useProjectsData } from "../../data/ProjectsProvider";
import { useTerminalPane } from "./TerminalPaneContext";

// docs/MISSION_CONTROL_PLAN.md §4.6 / §8 Phase M3 — replaces M1's "coming in M3" stub. Row
// anatomy per §4.6: status dot · index · title · cwd (relative to project root) · `⌁` iff
// agent-owned. The "●/○ running-vs-idle" distinction §4.6 sketches would need OS-level activity
// introspection the data model doesn't carry (TerminalStatus is just 'running' | 'exited') — every
// running terminal renders `●` here, a deliberate simplification, not a bug.

function relativeCwd(cwd: string, projectPath: string | undefined): string {
  if (projectPath && cwd.startsWith(projectPath)) {
    const rest = cwd.slice(projectPath.length).replace(/^\/+/, "");
    return rest ? `~/${rest}` : "~";
  }
  return cwd;
}

function statusGlyph(t: TerminalDTO, running: boolean): string {
  if (t.status === "exited") return t.exitCode === 0 ? "✓" : "✗";
  return running ? "●" : "○";
}

export function TerminalRail({ collapsed }: { collapsed: boolean }) {
  const { projects, allChats } = useProjectsData();
  const { terminals, activeId, setActiveId, runningIds } = useTerminalPane();

  if (collapsed) {
    return (
      <>
        {terminals.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`rama-mc-rail-icon-row${t.id === activeId ? " rama-mc-rail-icon-row-active" : ""}`}
            title={t.title}
            onClick={() => setActiveId(t.id)}
          >
            {statusGlyph(t, runningIds.has(t.id))}
          </button>
        ))}
      </>
    );
  }

  if (terminals.length === 0) {
    return (
      <div style={{ padding: "8px 12px", fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.4)" }}>no terminals yet.</div>
    );
  }

  return (
    <>
      {terminals.map((t, i) => {
        const running = runningIds.has(t.id);
        // §8 M3 reattach logic — DB says running, Rust doesn't have it: the app restarted.
        const endedRemotely = t.status === "running" && !running;
        const project = projects.find((p) => p.id === t.projectId);
        const originChat = t.originChatId ? allChats.find((c) => c.id === t.originChatId) : undefined;
        return (
          <div
            key={t.id}
            role="option"
            aria-selected={t.id === activeId}
            className="rama-artifact-row"
            onClick={() => setActiveId(t.id)}
          >
            <span className="rama-artifact-glyph">{statusGlyph(t, running)}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rama-artifact-name">
                {i + 1}. {t.title}
                {t.owner === "agent" && (
                  <span title={originChat ? `started by ${originChat.title}` : "started by an agent"}> ⌁</span>
                )}
              </div>
              <div className="rama-artifact-meta">{endedRemotely ? "ended — app restarted" : relativeCwd(t.cwd, project?.path)}</div>
            </div>
            {t.status === "exited" && <span className="rama-artifact-badge">{t.exitCode === 0 ? "ok" : `exit ${t.exitCode}`}</span>}
          </div>
        );
      })}
    </>
  );
}

// §4.6 — the rail header's `+`, rendered via the registry's `RailActions` slot.
export function TerminalRailActions() {
  const { activeProjectId } = useProjectsData();
  const { createTerminal } = useTerminalPane();
  return (
    <button
      type="button"
      className="rama-mc-rail-action-btn"
      title="New terminal (⌘⇧`)"
      disabled={!activeProjectId}
      onClick={() => void createTerminal()}
    >
      +
    </button>
  );
}
