import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@rama/ui";
import type { ChatDTO, ProjectDTO } from "@rama/protocol";
import { exitPty, fetchArtifactContent, fetchArtifacts, sendPtyData, startPty } from "../engine/client";

// Mirrors CommandPalette.tsx's own ⌘K/Ctrl+K check — the one global app chord today. Kept in
// sync manually since there's no shared registry of chords yet (see docs/IMPLEMENTATION_PLAN.md
// Phase 8's "app-chord interception").
// Matches --fs-md's base px (packages/ui/src/tokens.css) — xterm can't read that token directly
// (see the fontSize wiring below), so the base value is duplicated here deliberately.
const BASE_TERMINAL_FONT_SIZE = 12.5;

function isReservedChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

// Read raw (not resolved via getComputedStyle) — modern canvas 2D contexts, which is what
// xterm.js paints into, accept oklch()/relative-color strings directly, so the app's actual
// accent tokens (packages/ui/src/tokens.css) can be handed to xterm as-is.
function readThemeColors(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const v = (name: string) => style.getPropertyValue(name).trim();
  const ink = v("--ink");
  const foreground = `rgb(${ink})`;
  return {
    background: "transparent",
    foreground,
    cursor: v("--accent"),
    cursorAccent: v("--page-bg"),
    selectionBackground: v("--a25"),
    black: v("--page-bg"),
    brightBlack: `rgba(${ink}, 0.5)`,
    white: foreground,
    brightWhite: v("--ink-hi"),
    red: v("--bad"),
    brightRed: v("--bad-2"),
    green: v("--good"),
    brightGreen: v("--good"),
    yellow: v("--warn"),
    brightYellow: v("--warn"),
    blue: v("--accent"),
    brightBlue: v("--accent-bright"),
    magenta: v("--accent"),
    brightMagenta: v("--accent-bright"),
    cyan: v("--accent-bright"),
    brightCyan: v("--accent-bright"),
  };
}

// The whole ChatColumn for a cli-backed chat (docs/IMPLEMENTATION_PLAN.md Phase 8) — xterm.js's
// own keystroke stream is the composer here, required for real interactive TUIs (arrow-key
// history, ctrl-c, raw-mode prompts) that a line-buffered textarea couldn't drive. Rust owns the
// actual PTY process (apps/desktop/src-tauri/src/pty.rs) and outlives this component; the engine
// only mirrors its output into a "terminal" artifact for persistence (see engine/client.ts's
// startPty/sendPtyData/exitPty). Rendered with key={chat.id} by ChatColumn so switching between
// two different cli chats fully unmounts/remounts rather than reusing this instance.
export function TerminalView({ chat, project }: { chat: ChatDTO; project: ProjectDTO | undefined }) {
  const { themeId, fontScale } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const artifactIdRef = useRef<string | null>(null);
  const pendingRef = useRef("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [killing, setKilling] = useState(false);

  useEffect(() => {
    if (chat.backend.kind !== "cli" || !project) return;
    const backend = chat.backend;
    const projectPath = project.path;
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: readThemeColors(),
      fontFamily: "var(--font-mono)",
      // SETTINGS_PLAN.md Phase S3 — xterm has its own fontSize option and doesn't read CSS
      // custom properties, so "all the fonts of the app" needs this read explicitly at creation
      // (and again below, live, when the setting changes) rather than a --fs-* token.
      fontSize: BASE_TERMINAL_FONT_SIZE * fontScale,
      cursorBlink: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    term.attachCustomKeyEventHandler((e) => !isReservedChord(e));

    let cancelled = false;
    let unlistenData: (() => void) | null = null;
    let unlistenExit: (() => void) | null = null;

    async function flush() {
      const chunk = pendingRef.current;
      pendingRef.current = "";
      if (!chunk || !artifactIdRef.current) return;
      try {
        await sendPtyData(chat.id, artifactIdRef.current, chunk);
      } catch (err) {
        console.error("[rama] failed to persist pty output", err);
      }
    }

    const flushTimer = setInterval(() => void flush(), 1000);

    async function attach() {
      unlistenData = await listen<string>(`pty-data:${chat.id}`, (event) => {
        term.write(event.payload);
        pendingRef.current += event.payload;
      });
      unlistenExit = await listen<number>(`pty-exit:${chat.id}`, (event) => {
        if (cancelled) return;
        term.write(`\r\n\x1b[2m[process exited with code ${event.payload}]\x1b[0m\r\n`);
        setExitCode(event.payload);
        void flush().then(() => {
          if (artifactIdRef.current) exitPty(chat.id, artifactIdRef.current, event.payload).catch(() => {});
        });
      });

      const running = await invoke<boolean>("pty_is_running", { chatId: chat.id });
      if (cancelled) return;

      const history = await fetchArtifacts(chat.id).catch(() => []);
      const existing = history.find((a) => a.kind === "terminal");

      if (running && existing) {
        artifactIdRef.current = existing.id;
        const { content } = await fetchArtifactContent(existing.id).catch(() => ({ content: "" }));
        if (!cancelled) term.write(content);
        return;
      }

      const { artifactId } = await startPty(chat.id);
      if (cancelled) return;
      artifactIdRef.current = artifactId;
      await invoke("pty_spawn", {
        chatId: chat.id,
        command: backend.command,
        args: backend.args ?? [],
        cwd: projectPath,
        env: backend.env ?? {},
        cols: term.cols,
        rows: term.rows,
      });
    }

    void attach();

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      invoke("pty_resize", { chatId: chat.id, cols: term.cols, rows: term.rows }).catch(() => {});
    });
    resizeObserver.observe(container);

    const dataDisposable = term.onData((data) => {
      invoke("pty_write", { chatId: chat.id, data }).catch(() => {});
    });

    return () => {
      cancelled = true;
      clearInterval(flushTimer);
      void flush();
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unlistenData?.();
      unlistenExit?.();
      term.dispose();
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id]);

  // Re-theme live if the user switches theme while a terminal is open.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readThemeColors();
  }, [themeId]);

  // Re-scale live if the user changes font size (Appearance pane) while a terminal is open —
  // re-fit afterward so cols/rows (and the Rust-side PTY) catch up to the new character metrics.
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontSize = BASE_TERMINAL_FONT_SIZE * fontScale;
    fit.fit();
    invoke("pty_resize", { chatId: chat.id, cols: term.cols, rows: term.rows }).catch(() => {});
  }, [fontScale, chat.id]);

  if (chat.backend.kind !== "cli") return null;
  const commandLine = [chat.backend.command, ...(chat.backend.args ?? [])].join(" ");

  async function handleKill() {
    setKilling(true);
    try {
      await invoke("pty_kill", { chatId: chat.id });
    } finally {
      setKilling(false);
    }
  }

  return (
    <div className="rama-chat-column rama-terminal-column">
      <div className="rama-chat-header">
        <span style={{ color: "rgba(var(--ink),0.65)" }}>⌂ {project?.name ?? "—"}</span>
        <span style={{ opacity: 0.4 }}>›</span>
        <span style={{ color: "var(--accent-bright, var(--accent))" }}>{chat.title}</span>
        <span className="rama-terminal-command">{commandLine}</span>
        <span style={{ flex: 1 }} />
        {exitCode !== null && <span className="rama-badge">exited {exitCode}</span>}
        <button className="rama-composer-send" onClick={handleKill} disabled={killing || exitCode !== null}>
          kill
        </button>
      </div>
      <div ref={containerRef} className="rama-terminal-surface" />
    </div>
  );
}
