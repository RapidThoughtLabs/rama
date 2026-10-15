import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { TerminalDTO } from "@rama/protocol";
import { exitTerminal, fetchTerminalScrollback, postTerminalData, ptyIsRunning, ptyResize, ptyWrite } from "../../engine/client";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M2 — headless: attach/detach to the Rust-owned PTY
// (apps/desktop/src-tauri/src/pty.rs) and scrollback persistence, harvested from the deleted
// TerminalView.tsx's `attach()`/flush-interval (docs/MISSION_CONTROL_PLAN.md M0's harvest note).
// xterm itself lives in XtermSurface.tsx — this hook never touches the DOM.
//
// Spawning a *new* PTY is deliberately not this hook's job: by the time it mounts for a given
// terminal, `pty_spawn` has either already been called (TerminalPaneContext's "+" handler calls
// it right after creating the `terminals` row) or never will be for this terminal in this window
// (it's a pre-existing row — either still running elsewhere, in which case this reattaches, or
// exited, in which case it just replays the DB's persisted scrollback with no live listeners).
const FLUSH_INTERVAL_MS = 1000;

// When each terminal last printed something in this window — the Terminal rail calls a running shell
// "idle" once it has been quiet for a while (CR4). The engine's `updatedAt` only moves when
// scrollback is saved, so it is the floor and this is the live reading.
const lastOutputAt = new Map<string, number>();
export function terminalLastActivity(t: Pick<TerminalDTO, "id" | "updatedAt">): number {
  return Math.max(t.updatedAt, lastOutputAt.get(t.id) ?? 0);
}

export interface TerminalSession {
  /** User keystrokes → PTY. A no-op (silently swallowed) if nothing is actually running. */
  write: (data: string) => void;
  /** Authoritative resize, called on fit() — see XtermSurface's ResizeObserver. */
  resize: (cols: number, rows: number) => void;
  running: boolean;
  exitCode: number | null;
}

export function useTerminalSession(terminal: TerminalDTO, onData: (chunk: string) => void): TerminalSession {
  const [running, setRunning] = useState(false);
  const [exitCode, setExitCode] = useState<number | null>(terminal.exitCode);
  const pendingRef = useRef("");
  // Read inside the mount effect's async attach() without needing `onData` in its dep array —
  // a fresh function identity on every render would otherwise re-run the whole attach dance.
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    async function flush() {
      const chunk = pendingRef.current;
      pendingRef.current = "";
      if (!chunk) return;
      try {
        await postTerminalData(terminal.id, chunk);
      } catch (err) {
        console.error("[rama] failed to persist terminal scrollback", err);
      }
    }
    const flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);

    async function attach() {
      const { content } = await fetchTerminalScrollback(terminal.id).catch(() => ({ content: "" }));
      if (cancelled) return;
      if (content) onDataRef.current(content);

      const alive = await ptyIsRunning(terminal.id).catch(() => false);
      if (cancelled) return;
      setRunning(alive);
      if (!alive) return;

      unlistenData = await listen<string>(`pty-data:${terminal.id}`, (event) => {
        lastOutputAt.set(terminal.id, Date.now());
        onDataRef.current(event.payload);
        pendingRef.current += event.payload;
      });
      unlistenExit = await listen<number>(`pty-exit:${terminal.id}`, (event) => {
        if (cancelled) return;
        onDataRef.current(`\r\n\x1b[2m[process exited with code ${event.payload}]\x1b[0m\r\n`);
        setRunning(false);
        setExitCode(event.payload);
        void flush().then(() => {
          exitTerminal(terminal.id, event.payload).catch(() => {});
        });
      });
    }
    void attach();

    return () => {
      cancelled = true;
      clearInterval(flushTimer);
      void flush();
      unlistenData?.();
      unlistenExit?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  return {
    write: (data: string) => void ptyWrite(terminal.id, data).catch(() => {}),
    resize: (cols: number, rows: number) => void ptyResize(terminal.id, cols, rows).catch(() => {}),
    running,
    exitCode,
  };
}
