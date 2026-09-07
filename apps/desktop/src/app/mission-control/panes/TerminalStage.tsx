import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { useProjectsData } from "../../data/ProjectsProvider";
import { XtermSurface } from "../XtermSurface";
import { useTerminalPane } from "./TerminalPaneContext";

// docs/MISSION_CONTROL_PLAN.md §4.6 / §8 Phase M3 — stage toolbar: cwd breadcrumb · command ·
// `⌫` clear · `⏹` kill (disabled once exited). `key={active.id}` on XtermSurface below is
// deliberate: switching the selected terminal fully unmounts/remounts the xterm instance rather
// than reusing it, same as the old TerminalView.tsx did per-chat.
export function TerminalStage() {
  const { projects } = useProjectsData();
  const { active, runningIds, killTerminal } = useTerminalPane();
  const termRef = useRef<Terminal | null>(null);

  if (!active) {
    return <div className="rama-mc-coming-soon">no terminal selected — press + to start one.</div>;
  }

  const project = projects.find((p) => p.id === active.projectId);
  const cwdLabel =
    project && active.cwd.startsWith(project.path) ? `~${active.cwd.slice(project.path.length) || "/"}` : active.cwd;
  const commandLine = [active.shell, ...active.argv].join(" ");
  const running = runningIds.has(active.id) && active.status === "running";

  return (
    <>
      <div className="rama-artifact-preview-toolbar">
        <span
          style={{
            fontSize: "var(--fs-sm)",
            color: "rgb(var(--ink))",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {cwdLabel}
        </span>
        <span style={{ fontSize: "var(--fs-micro)", color: "rgba(var(--ink),0.4)" }}>{commandLine}</span>
        <span style={{ flex: 1 }} />
        {active.status === "exited" && (
          <span className={`rama-badge ${active.exitCode === 0 ? "rama-badge-good" : "rama-badge-warn"}`}>
            exit {active.exitCode}
          </span>
        )}
        <button type="button" className="rama-btn rama-btn-icon" title="Clear" onClick={() => termRef.current?.clear()}>
          ⌫
        </button>
        <button
          type="button"
          className="rama-btn rama-btn-icon"
          title="Kill"
          disabled={!running}
          onClick={() => void killTerminal(active.id)}
        >
          ⏹
        </button>
      </div>
      <XtermSurface key={active.id} terminal={active} onTerminal={(t) => (termRef.current = t)} />
    </>
  );
}
