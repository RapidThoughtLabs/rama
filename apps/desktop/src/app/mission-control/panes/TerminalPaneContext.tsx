import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { TerminalDTO } from "@rama/protocol";
import {
  createTerminal as createTerminalApi,
  deleteTerminal as deleteTerminalApi,
  exitTerminal,
  fetchProjectTerminals,
  ptyKill,
  ptyListRunning,
  ptySpawn,
  renameTerminal as renameTerminalApi,
} from "../../../engine/client";
import { onProjectEvent, send } from "../../../engine/ws";
import { useProjectsData } from "../../data/ProjectsProvider";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M3 — the terminal list + selection state shared between
// TerminalRail and TerminalStage, mirroring ArtifactsPaneContext.tsx's split. Unlike Artifacts,
// there is no always-mounted provider of the underlying data (SessionProvider plays that role for
// artifacts) — this *is* the data layer for terminals, so it owns the project WS subscription and
// the `terminals` list, not just a selected-row index. Terminals are project-scoped (§0.2), so a
// chat switch within the same project must never reload this; only `activeProjectId` may.

interface TerminalPaneValue {
  terminals: TerminalDTO[];
  active: TerminalDTO | null;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
  /** `pty_list_running()` — a terminal whose DB status is 'running' but isn't in this set has
   *  survived a window close (fine) or an app restart (render "ended — app restarted", §8 M3). */
  runningIds: Set<string>;
  createTerminal: () => Promise<void>;
  killTerminal: (id: string) => Promise<void>;
  renameTerminal: (id: string, title: string) => Promise<void>;
  removeTerminal: (id: string) => Promise<void>;
}

const TerminalPaneContext = createContext<TerminalPaneValue | null>(null);

// Exported standalone (not just through the context) so CommandPalette.tsx's `⌘⇧\`` chord can
// create a terminal even when the Terminal pane — and therefore TerminalPaneProvider — isn't
// currently mounted (§4.9: the chord's job is "new terminal", not just "switch to the pane"). The
// engine POST is the terminal's source of truth either way; a not-yet-mounted provider just means
// this window won't see it in its list until the pane is opened and re-fetches from the engine.
export async function createProjectTerminal(projectId: string): Promise<TerminalDTO> {
  const terminal = await createTerminalApi({ projectId });
  try {
    await ptySpawn({ terminalId: terminal.id, command: terminal.shell, args: terminal.argv, cwd: terminal.cwd, env: {}, cols: 80, rows: 24 });
  } catch (err) {
    console.error("[rama] failed to spawn terminal", err);
  }
  return terminal;
}

export function TerminalPaneProvider({ children }: { children: ReactNode }) {
  const { activeProjectId } = useProjectsData();
  const [terminals, setTerminals] = useState<TerminalDTO[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    setTerminals([]);
    setActiveId(null);
    if (!activeProjectId) return;

    let cancelled = false;
    void send({ type: "subscribeProject", projectId: activeProjectId });
    fetchProjectTerminals(activeProjectId)
      .then((list) => {
        if (!cancelled) setTerminals(list);
      })
      .catch((err) => console.error("[rama] failed to load terminals", err));
    ptyListRunning()
      .then((ids) => {
        if (!cancelled) setRunningIds(new Set(ids));
      })
      .catch((err) => console.error("[rama] failed to list running terminals", err));

    return () => {
      cancelled = true;
      void send({ type: "unsubscribeProject", projectId: activeProjectId });
    };
  }, [activeProjectId]);

  useEffect(() => {
    return onProjectEvent((projectId, event) => {
      if (projectId !== activeProjectId) return;
      if (event.type === "terminal.created") {
        setTerminals((prev) => (prev.some((t) => t.id === event.terminal.id) ? prev : [...prev, event.terminal]));
        setRunningIds((prev) => new Set(prev).add(event.terminal.id));
      } else if (event.type === "terminal.exited") {
        setTerminals((prev) =>
          prev.map((t) => (t.id === event.terminalId ? { ...t, status: "exited", exitCode: event.exitCode } : t)),
        );
        setRunningIds((prev) => {
          if (!prev.has(event.terminalId)) return prev;
          const next = new Set(prev);
          next.delete(event.terminalId);
          return next;
        });
      } else if (event.type === "terminal.renamed") {
        setTerminals((prev) => prev.map((t) => (t.id === event.terminalId ? { ...t, title: event.title } : t)));
      }
    });
  }, [activeProjectId]);

  // First load picks the newest terminal (a chord- or agent-created one the user is most likely
  // waiting on); later arrivals never steal focus from whatever the user has selected.
  useEffect(() => {
    if (terminals.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !terminals.some((t) => t.id === activeId)) {
      setActiveId(terminals[terminals.length - 1].id);
    }
  }, [terminals, activeId]);

  const active = terminals.find((t) => t.id === activeId) ?? null;

  const createTerminal = useCallback(async () => {
    if (!activeProjectId) return;
    const terminal = await createProjectTerminal(activeProjectId);
    setTerminals((prev) => (prev.some((t) => t.id === terminal.id) ? prev : [...prev, terminal]));
    setRunningIds((prev) => new Set(prev).add(terminal.id));
    setActiveId(terminal.id);
  }, [activeProjectId]);

  // Proactively marks the row exited via the engine (not just Rust) — the natural `pty-exit`
  // Tauri event only reaches a window that currently has this terminal attached in a mounted
  // XtermSurface (see useTerminalSession.ts); killing a row that isn't the selected one needs
  // this so the DB (and every window's `terminal.exited` broadcast) catches up regardless.
  const killTerminal = useCallback(async (id: string) => {
    await ptyKill(id).catch(() => {});
    await exitTerminal(id, -1).catch(() => {});
  }, []);

  const renameTerminal = useCallback(async (id: string, title: string) => {
    const updated = await renameTerminalApi(id, title);
    setTerminals((prev) => prev.map((t) => (t.id === id ? updated : t)));
  }, []);

  const removeTerminal = useCallback(async (id: string) => {
    await deleteTerminalApi(id);
    setTerminals((prev) => prev.filter((t) => t.id !== id));
    setActiveId((prev) => (prev === id ? null : prev));
  }, []);

  const value = useMemo<TerminalPaneValue>(
    () => ({ terminals, active, activeId, setActiveId, runningIds, createTerminal, killTerminal, renameTerminal, removeTerminal }),
    [terminals, active, activeId, runningIds, createTerminal, killTerminal, renameTerminal, removeTerminal],
  );

  return <TerminalPaneContext.Provider value={value}>{children}</TerminalPaneContext.Provider>;
}

export function useTerminalPane(): TerminalPaneValue {
  const ctx = useContext(TerminalPaneContext);
  if (!ctx) throw new Error("useTerminalPane must be used within a TerminalPaneProvider");
  return ctx;
}
