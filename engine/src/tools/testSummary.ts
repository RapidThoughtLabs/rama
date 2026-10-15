// docs/CODE_REDESIGN_PLAN.md CR6 / E5 — find a test runner's final tally in a command's output, so the
// transcript row can say "31 passed" instead of "exit 0 · 14 lines". Looks only at the output's tail
// (a summary is always last), and only matches the runners' own summary lines — a stray "3 passed"
// in a log never counts.

export interface TestTally {
  passed: number;
  failed: number;
}

const TAIL_CHARS = 4000;

const num = (s: string | undefined) => (s ? Number(s) : 0);

export function parseTestSummary(output: string): TestTally | null {
  const tail = output.slice(-TAIL_CHARS);

  // cargo: "test result: ok. 31 passed; 0 failed; 0 ignored; …" (one line per test binary — sum them)
  const cargo = [...tail.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed/g)];
  if (cargo.length) return { passed: cargo.reduce((n, m) => n + num(m[1]), 0), failed: cargo.reduce((n, m) => n + num(m[2]), 0) };

  // bun: " 31 pass\n 0 fail\n"
  const bunPass = tail.match(/^\s*(\d+) pass\s*$/m);
  if (bunPass) return { passed: num(bunPass[1]), failed: num(tail.match(/^\s*(\d+) fail\s*$/m)?.[1]) };

  // jest: "Tests:       1 failed, 30 passed, 31 total"   vitest: "Tests  1 failed | 30 passed (31)"
  const jest = tail.match(/^\s*Tests:?\s+(.*\b(?:passed|failed)\b.*)$/m);
  if (jest) {
    const line = jest[1]!;
    return { passed: num(line.match(/(\d+) passed/)?.[1]), failed: num(line.match(/(\d+) failed/)?.[1]) };
  }

  // pytest: "===== 1 failed, 30 passed in 0.52s =====" (or just "30 passed in 0.52s")
  const py = tail.match(/^=*\s*((?:\d+ (?:failed|passed|skipped|errors?|warnings?|deselected|xfailed|xpassed)(?:, )?)+) in [\d.]+s/m);
  if (py) return { passed: num(py[1]!.match(/(\d+) passed/)?.[1]), failed: num(py[1]!.match(/(\d+) (?:failed|errors?)/)?.[1]) };

  return null;
}

/** " · 31 passed" / " · 2 failed" (failures win), or "" when the output has no summary. */
export function testSummarySuffix(output: string): string {
  const t = parseTestSummary(output);
  if (!t) return "";
  if (t.failed > 0) return ` · ${t.failed} failed`;
  return t.passed > 0 ? ` · ${t.passed} passed` : "";
}

/** `git commit`'s first line: "[main 4c1e9a2] Subject" → "main 4c1e9a2". */
export function parseCommitLine(output: string): string | null {
  const m = output.match(/^\[(\S+?)(?: \(root-commit\))? ([0-9a-f]{7,40})\]/m);
  return m ? `${m[1]} ${m[2]!.slice(0, 7)}` : null;
}
