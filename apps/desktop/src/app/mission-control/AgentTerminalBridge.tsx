import { useEffect } from "react";
import { exitTerminal, ptyIsRunning, ptyKill, ptySpawn } from "../../engine/client";
import { onProjectEvent, send } from "../../engine/ws";
import { useProjectsData } from "../data/ProjectsProvider";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M4 (§7.1) — the engine (a headless Bun process) has no
// way to call a Tauri command, so it can only create the `terminals` row for an agent-started
// background shell and broadcast `terminal.created`; only the frontend can actually call
// `pty_spawn`. This has to be mounted unconditionally (AppShell.tsx, not gated on the Terminal
// pane being open, Mission Control being expanded, or even which project's chat happens to be
// active) — the whole point of `bash background:true` is that a dev server starts whether or not
// anyone is looking, in whichever project the agent that ran it was working in. Subscribes to
// every project's topic, not just the active one, for that reason. `pty_spawn` is idempotent per
// terminal_id (pty.rs), so more than one open window reacting to the same broadcast is harmless.
export function AgentTerminalBridge() {
  const { projects } = useProjectsData();
  const projectIds = projects.map((p) => p.id).join(",");

  useEffect(() => {
    const ids = projectIds ? projectIds.split(",") : [];
    for (const id of ids) void send({ type: "subscribeProject", projectId: id });
    return () => {
      for (const id of ids) void send({ type: "unsubscribeProject", projectId: id });
    };
  }, [projectIds]);

  useEffect(() => {
    return onProjectEvent((_projectId, event) => {
      if (event.type === "terminal.created" && event.terminal.owner === "agent") {
        const terminal = event.terminal;
        void ptyIsRunning(terminal.id)
          .catch(() => false)
          .then((running) => {
            if (running) return;
            return ptySpawn({
              terminalId: terminal.id,
              command: terminal.shell,
              args: terminal.argv,
              cwd: terminal.cwd,
              env: {},
              cols: 80,
              rows: 24,
            });
          })
          .catch((err) => console.error("[rama] failed to spawn agent terminal", err));
        return;
      }
      // docs/MISSION_CONTROL_PLAN.md §7.3 — the `process kill` tool's request, same "engine can't
      // call Tauri itself" reason as above. Mirrors TerminalPaneContext.tsx's own killTerminal:
      // kill the real PTY, then mark the row exited regardless of whether anything is attached.
      if (event.type === "terminal.kill_requested") {
        void ptyKill(event.terminalId)
          .catch(() => {})
          .then(() => exitTerminal(event.terminalId, -1))
          .catch((err) => console.error("[rama] failed to kill terminal", err));
      }
    });
  }, []);

  return null;
}
