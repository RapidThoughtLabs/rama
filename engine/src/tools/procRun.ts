// Shared batch (non-streaming) subprocess runner with a hard timeout and abort wiring — used
// by tools that need a command's full output but don't need to stream it live (grep). `bash`
// has its own streaming reader since it broadcasts output incrementally.
export async function runWithTimeout(
  cmd: string[],
  opts: { cwd: string; timeoutMs: number; abortSignal?: AbortSignal },
): Promise<{ output: string; exitCode: number; timedOut: boolean }> {
  const proc = Bun.spawn({ cmd, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs);

  const onAbort = () => proc.kill();
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;

  clearTimeout(timer);
  opts.abortSignal?.removeEventListener("abort", onAbort);

  return { output: stdout + stderr, exitCode, timedOut };
}
