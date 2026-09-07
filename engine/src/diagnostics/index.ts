import { runWithTimeout } from "../tools/procRun";
import type { Diagnostic } from "../tools/types";
import { resolveCommands, type CheckKind } from "./commands";
import { parseEslintJson, parseGenericLine, parseTestOutput, parseTsc } from "./parsers";

export type { CheckKind } from "./commands";

export interface CheckResult {
  kind: CheckKind;
  ran: boolean;
  ok: boolean;
  issueCount: number;
}

export interface CheckSummary {
  results: CheckResult[];
}

export interface DiagnosticRunner {
  /** Fast, automatic, post-edit — see docs/TOOL_LAYER_PLAN.md §5.4. Currently typecheck only,
   *  filtered to the paths just touched. */
  fast(paths: string[]): Promise<Diagnostic[]>;
  /** Slow, project-wide — backs the `check` tool. `raw` carries head+tail-truncatable raw output
   *  for any requested kind whose output didn't parse into anything on a failing run. */
  full(kinds: CheckKind[]): Promise<{ diagnostics: Diagnostic[]; summary: CheckSummary; raw: Partial<Record<CheckKind, string>> }>;
}

const CHECK_TIMEOUT_MS = 120_000;

interface KindOutcome {
  ran: boolean;
  ok: boolean;
  diagnostics: Diagnostic[];
  raw?: string;
}

async function runKind(projectPath: string, kind: CheckKind): Promise<KindOutcome> {
  const commands = resolveCommands(projectPath);
  const cmd = commands[kind];
  if (!cmd) return { ran: false, ok: true, diagnostics: [] };

  const { output, exitCode, timedOut } = await runWithTimeout(cmd, { cwd: projectPath, timeoutMs: CHECK_TIMEOUT_MS });
  const ok = !timedOut && exitCode === 0;

  let diagnostics: Diagnostic[];
  if (kind === "typecheck") diagnostics = parseTsc(output);
  else if (kind === "lint") diagnostics = parseEslintJson(output) ?? parseGenericLine(output, "eslint");
  else if (kind === "test") diagnostics = parseTestOutput(output);
  else diagnostics = parseGenericLine(output, "build");

  // Never drop a failure silently (§5.4): a nonzero exit with nothing structured to show still
  // needs to reach the model somehow.
  if (diagnostics.length === 0 && !ok) return { ran: true, ok: false, diagnostics: [], raw: output };
  return { ran: true, ok, diagnostics };
}

export function createDiagnosticRunner(projectPath: string): DiagnosticRunner {
  return {
    async fast(paths) {
      const result = await runKind(projectPath, "typecheck");
      if (!result.ran) return [];
      // tsc re-typechecks the whole project (there's no reliable single-file mode that respects
      // real project references) — this filters its output down to just the touched paths so the
      // model only sees what it needs to react to right now. Real incremental scoping is future
      // work, not this phase's.
      const wanted = new Set(paths.map((p) => p.replace(/^\.\//, "")));
      return result.diagnostics.filter((d) => wanted.has(d.file.replace(/^\.\//, "")));
    },

    async full(kinds) {
      const results: CheckResult[] = [];
      const diagnostics: Diagnostic[] = [];
      const raw: Partial<Record<CheckKind, string>> = {};

      for (const kind of kinds) {
        const outcome = await runKind(projectPath, kind);
        results.push({ kind, ran: outcome.ran, ok: outcome.ok, issueCount: outcome.diagnostics.length });
        diagnostics.push(...outcome.diagnostics);
        if (outcome.raw) raw[kind] = outcome.raw;
      }

      return { diagnostics, summary: { results }, raw };
    },
  };
}
