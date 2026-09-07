// docs/TOOL_LAYER_PLAN.md §5.5 (TL3) — one persistent shell per run so `cd`, exported vars, and
// activated environments (nvm, venv, direnv) survive across `bash` calls in the same turn, instead
// of evaporating with every `Bun.spawn` like the old per-call implementation. Plain piped stdio,
// no PTY — see the "Correction" note in the plan for why a tty would be wrong here.
const MAX_OUTPUT_BYTES = 100_000;

export interface ShellResult {
  output: string;
  outputTruncated: boolean;
  exitCode: number;
  timedOut: boolean;
  aborted: boolean;
  /** Whether the underlying shell process died or was killed and had to be respawned — the
   *  model should know its session state (cwd, exports) reset. */
  sessionReset: boolean;
  cwd: string;
  durationMs: number;
}

export interface ShellSession {
  run(
    cmd: string,
    opts: { timeoutMs: number; signal: AbortSignal; onChunk?: (text: string) => void },
  ): Promise<ShellResult>;
  cwd(): string;
  dispose(): Promise<void>;
}

type Proc = Bun.PipedSubprocess;

interface LiveProcess {
  proc: Proc;
  stdoutReader: ReadableStreamDefaultReader<Uint8Array>;
  // The user command's own stderr is merged into stdout via `{ ...; } 2>&1` below, so this only
  // ever catches shell-level errors outside that group (e.g. malformed control lines). Drained
  // continuously in the background, independent of any one command's completion.
  stderrBuffer: string;
}

const decoder = new TextDecoder();

export function createShellSession(projectPath: string): ShellSession {
  let cwd = projectPath;
  let live: LiveProcess | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();
  // Distinguishes "first command in a brand-new session" (nothing to lose, not a reset) from
  // "had to respawn after a crash/timeout/abort" (state genuinely lost) — both go through the
  // same ensureLive() spawn path, but only the latter should ever be reported to the caller.
  let everSpawned = false;

  function isAlive(p: LiveProcess): boolean {
    return p.proc.exitCode === null && p.proc.signalCode === null;
  }

  function spawn(): LiveProcess {
    const proc = Bun.spawn<"pipe", "pipe", "pipe">({
      cmd: ["/bin/sh"],
      cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const p: LiveProcess = { proc, stdoutReader: proc.stdout.getReader(), stderrBuffer: "" };
    void (async () => {
      const reader = proc.stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          p.stderrBuffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // process torn down mid-read — nothing to drain anymore
      }
    })();
    return p;
  }

  function ensureLive(): { session: LiveProcess; reset: boolean } {
    if (live && isAlive(live)) return { session: live, reset: false };
    const reset = everSpawned;
    live = spawn();
    everSpawned = true;
    return { session: live, reset };
  }

  async function killLive(): Promise<void> {
    if (!live) return;
    const dead = live;
    live = null;
    try {
      dead.proc.kill();
    } catch {
      // already gone
    }
    try {
      await dead.proc.exited;
    } catch {
      // ignore — we only wanted it stopped
    }
  }

  async function runOne(
    cmd: string,
    opts: { timeoutMs: number; signal: AbortSignal; onChunk?: (text: string) => void },
  ): Promise<ShellResult> {
    const started = Date.now();
    const cwdBefore = cwd;
    const { session, reset } = ensureLive();

    const nonce = Math.random().toString(36).slice(2, 10);
    const EXIT_MARK = `__rama_exit_${nonce}__`;
    const END_MARK = `__rama_end_${nonce}__`;
    // Braces group in the *current* shell (no fork), unlike `( ... )` — so `cd`/`export` inside
    // `cmd` still persists for the next call. `2>&1` on the group merges the command's own stderr
    // into stdout in the right order, which two separately-pumped pipes could not guarantee.
    const script = `{\n${cmd}\n} 2>&1\nprintf '\\n${EXIT_MARK}:%d\\n' "$?"\npwd\nprintf '${END_MARK}\\n'\n`;

    const stderrPrefix = session.stderrBuffer;
    session.stderrBuffer = "";

    try {
      session.proc.stdin.write(script);
      session.proc.stdin.flush();
    } catch {
      // The process died between ensureLive() and this write (e.g. killed out of band). Fall
      // through to the read loop below, which will see the closed stream and report it as dead.
    }

    let buffer = "";
    let flushed = 0; // how much of `buffer` has already been forwarded via onChunk
    const exitRe = new RegExp(`${EXIT_MARK}:(-?\\d+)\\n`);

    // Any real output is fully written by the `{ ... }` group before our own `printf`/`pwd`
    // lines even start executing (same script, same shell, strictly sequential) — so once
    // `\n${EXIT_MARK}` appears anywhere in the buffer, everything after that point is our own
    // sentinel machinery and must never reach a live view. `stderrPrefix` (leftover from a
    // previous command's out-of-band shell-level stderr, vanishingly rare) is treated as though
    // it just arrived, so it's forwarded once rather than silently dropped.
    const flush = (text: string) => {
      buffer += text;
      const markerIdx = buffer.indexOf(`\n${EXIT_MARK}`);
      const visibleEnd = markerIdx === -1 ? buffer.length : markerIdx;
      if (visibleEnd > flushed) {
        opts.onChunk?.(buffer.slice(flushed, visibleEnd));
        flushed = visibleEnd;
      }
    };
    if (stderrPrefix) flush(stderrPrefix);

    const readUntilDone = async (): Promise<{ exitCode: number } | null> => {
      while (true) {
        const { done, value } = await session.stdoutReader.read();
        if (done) return null;
        flush(decoder.decode(value, { stream: true }));
        const endIdx = buffer.indexOf(`${END_MARK}\n`);
        if (endIdx === -1) continue;
        const before = buffer.slice(0, endIdx);
        const m = before.match(exitRe);
        if (!m) return null;
        const exitIdx = before.indexOf(m[0]);
        let out = before.slice(0, exitIdx);
        if (out.endsWith("\n")) out = out.slice(0, -1);
        const pwdOut = before.slice(exitIdx + m[0].length).replace(/\n$/, "");
        buffer = out;
        if (pwdOut) cwd = pwdOut;
        return { exitCode: Number.parseInt(m[1], 10) };
      }
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), opts.timeoutMs);
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"aborted">((resolve) => {
      onAbort = () => resolve("aborted");
      opts.signal.addEventListener("abort", onAbort, { once: true });
    });

    const outcome = await Promise.race([readUntilDone(), timeout, aborted]);

    clearTimeout(timer);
    if (onAbort) opts.signal.removeEventListener("abort", onAbort);

    const durationMs = Date.now() - started;
    const truncate = (text: string) =>
      text.length > MAX_OUTPUT_BYTES
        ? { output: text.slice(0, MAX_OUTPUT_BYTES), outputTruncated: true }
        : { output: text, outputTruncated: false };

    if (outcome === "timeout" || outcome === "aborted") {
      await killLive();
      return {
        ...truncate(buffer),
        exitCode: -1,
        timedOut: outcome === "timeout",
        aborted: outcome === "aborted",
        sessionReset: true,
        cwd: cwdBefore,
        durationMs,
      };
    }

    if (outcome === null) {
      // Stream closed before we saw our own end marker — the shell process died mid-command
      // (it ran `exit`, crashed, or was killed out of band). Respawn lazily on the next call.
      const exitCode = await session.proc.exited.catch(() => -1);
      if (live === session) live = null;
      return {
        ...truncate(buffer),
        exitCode,
        timedOut: false,
        aborted: false,
        sessionReset: true,
        cwd: cwdBefore,
        durationMs,
      };
    }

    return {
      ...truncate(buffer),
      exitCode: outcome.exitCode,
      timedOut: false,
      aborted: false,
      sessionReset: reset,
      cwd,
      durationMs,
    };
  }

  return {
    run(cmd, opts) {
      if (disposed) return Promise.reject(new Error("shell session already disposed"));
      const task = queue.then(() => runOne(cmd, opts));
      queue = task.then(
        () => {},
        () => {},
      );
      return task;
    },
    cwd() {
      return cwd;
    },
    async dispose() {
      disposed = true;
      await killLive();
    },
  };
}
