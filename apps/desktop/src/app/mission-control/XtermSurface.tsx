import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useTheme } from "@rama/ui";
import type { TerminalDTO } from "@rama/protocol";
import { useTerminalSession } from "./useTerminalSession";

// docs/MISSION_CONTROL_PLAN.md §8 Phase M2 — "dumb, themed, takes a session." The font-scale and
// reserved-chord handling are harvested from the deleted TerminalView.tsx; the PTY attach/detach
// logic lives in useTerminalSession.ts. CR4 restyled the colours, font and spacing to the mockup.

// Mirrors CommandPalette.tsx's own ⌘K/Ctrl+K check — the one global app chord that must still
// reach the palette even while an xterm has focus.
const BASE_TERMINAL_FONT_SIZE = 12.5; // matches --fs-md's base px; xterm can't read CSS custom properties

function isReservedChord(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
}

// xterm paints with a canvas and takes concrete colours, but the theme's tokens are CSS variables
// that may be `color-mix()` expressions (docs/CODE_REDESIGN_PLAN.md CR4). A probe element resolves
// each token through the cascade; a 1×1 canvas then flattens whatever the engine returns (rgb,
// oklab, color(srgb …)) into an `rgba()` string xterm can parse.
let probe: HTMLSpanElement | null = null;
let swatch: CanvasRenderingContext2D | null = null;

function resolveColor(token: string): string {
  if (!probe) {
    probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  }
  document.documentElement.appendChild(probe);
  probe.style.color = `var(${token})`;
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  swatch ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!swatch) return resolved;
  swatch.canvas.width = swatch.canvas.height = 1;
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = resolved;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  return `rgba(${r}, ${g}, ${b}, ${(a! / 255).toFixed(3)})`;
}

// Mockup map (mock:L485-489): text is --ink-1, the prompt and cursor --accent, dim output --ink-4,
// success --good. The remaining ANSI slots borrow the nearest theme colours.
function readThemeColors(): ITheme {
  const c = resolveColor;
  const ink = c("--ink-1");
  const accent = c("--accent");
  const dim = c("--ink-4");
  const good = c("--good");
  const bad = c("--bad");
  const warn = c("--warn");
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: ink,
    cursor: accent,
    cursorAccent: c("--code-bg"),
    selectionBackground: c("--selected"),
    black: dim,
    brightBlack: dim,
    white: c("--ink-2"),
    brightWhite: ink,
    red: bad,
    brightRed: bad,
    green: good,
    brightGreen: good,
    yellow: warn,
    brightYellow: warn,
    blue: accent,
    brightBlue: accent,
    magenta: accent,
    brightMagenta: accent,
    cyan: accent,
    brightCyan: accent,
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
      // xterm can't resolve `var(--…)`, so the family is spelled out (mock --f-code).
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", monospace',
      fontSize: BASE_TERMINAL_FONT_SIZE * fontScale,
      // The mockup sets line-height 1.7 on the font size (21px at 12.5). xterm multiplies the font's
      // own line box (~16.8px here), so the same 21px rows are 1.27.
      lineHeight: 1.27,
      cursorBlink: true,
      allowProposedApi: true,
      allowTransparency: true,
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
      // xterm queues a viewport refresh on animation frames; disposing under it throws "reading
      // 'dimensions'" when the frame fires. Let the queued frames run first.
      requestAnimationFrame(() => requestAnimationFrame(() => term.dispose()));
      termRef.current = null;
      fitRef.current = null;
      onTerminalRef.current?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal.id]);

  // Re-theme live if the user switches theme while a terminal is open. The ThemeProvider writes the
  // new tokens in its own effect, which runs after this one, so read them a tick later.
  useEffect(() => {
    const id = setTimeout(() => {
      if (termRef.current) termRef.current.options.theme = readThemeColors();
    }, 0);
    return () => clearTimeout(id);
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

  return <div ref={containerRef} className="r-term-surface" data-pixel-mask />;
}
