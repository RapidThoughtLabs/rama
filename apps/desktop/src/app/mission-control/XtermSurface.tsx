import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@rama/ui";
import type { TerminalDTO } from "@rama/protocol";
import { useTerminalSession } from "./useTerminalSession";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M2 — "dumb, themed, takes a session." Everything below
// (BASE_TERMINAL_FONT_SIZE, isReservedChord, readThemeColors, the fontScale effect) is harvested
// verbatim from the deleted TerminalView.tsx (M0's harvest note); only the PTY attach/detach
// logic moved out into useTerminalSession.ts.

// Mirrors CommandPalette.tsx's own ⌘K/Ctrl+K check — the one global app chord that must still
// reach the palette even while an xterm has focus.
const BASE_TERMINAL_FONT_SIZE = 12.5; // matches --fs-md's base px; xterm can't read CSS custom properties

function isReservedChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

// Read raw (not resolved via getComputedStyle) — modern canvas 2D contexts, which is what
// xterm.js paints into, accept oklch()/relative-color strings directly.
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

export function XtermSurface({ terminal, onTerminal }: { terminal: TerminalDTO; onTerminal?: (term: Terminal | null) => void }) {
  const { themeId, fontScale } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const session = useTerminalSession(terminal, (chunk) => termRef.current?.write(chunk));

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      theme: readThemeColors(),
      fontFamily: "var(--font-mono)",
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
    onTerminalRef.current?.(term);

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      session.resize(term.cols, term.rows);
    });
    resizeObserver.observe(container);

    const dataDisposable = term.onData((data) => session.write(data));

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      onTerminalRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

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
    session.resize(term.cols, term.rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontScale]);

  return <div ref={containerRef} className="rama-terminal-surface" />;
}
