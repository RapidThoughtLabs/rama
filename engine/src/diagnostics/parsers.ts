import type { Diagnostic } from "../tools/types";

// docs/TOOL_LAYER_PLAN.md §5.4 — each parser normalises one tool's raw output into Diagnostic[].
// None of these need to be exhaustive: index.ts's runKind() falls back to raw head+tail text
// whenever a parser returns nothing on a failing run, so an unrecognised format degrades instead
// of losing the failure entirely.

// tsc invoked with --pretty false (see commands.ts's detectTypecheck) emits one line per
// diagnostic: "path(line,col): error TS1234: message". The pretty form is multi-line and
// colorized and is not handled — only the invocations this module controls guarantee this format.
const TSC_LINE = /^(.+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm;

export function parseTsc(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const m of output.matchAll(TSC_LINE)) {
    diagnostics.push({
      file: m[1]!.trim(),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: m[4] === "warning" ? "warning" : "error",
      code: m[5],
      message: m[6]!.trim(),
      source: "tsc",
    });
  }
  return diagnostics;
}

interface EslintMessage {
  line: number;
  column?: number;
  severity: number;
  message: string;
  ruleId?: string | null;
}
interface EslintFileResult {
  filePath: string;
  messages: EslintMessage[];
}

// `eslint --format json` (see commands.ts's detectLint). Returns null (not empty) on anything
// that isn't the expected shape, so the caller can tell "parsed, zero issues" apart from
// "couldn't parse this at all" and fall back to raw text for the latter.
export function parseEslintJson(output: string): Diagnostic[] | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return null;
    const diagnostics: Diagnostic[] = [];
    for (const file of parsed as EslintFileResult[]) {
      for (const msg of file.messages ?? []) {
        diagnostics.push({
          file: file.filePath,
          line: msg.line,
          col: msg.column,
          severity: msg.severity >= 2 ? "error" : "warning",
          message: msg.message,
          code: msg.ruleId ?? undefined,
          source: "eslint",
        });
      }
    }
    return diagnostics;
  } catch {
    return null;
  }
}

// Generic `file:line:col: message` — some linters/build tools and a last-resort attempt before
// giving up on any of the structured parsers above.
const GENERIC_LINE = /^(.+?):(\d+):(\d+):\s*(.+)$/gm;

export function parseGenericLine(output: string, source: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const m of output.matchAll(GENERIC_LINE)) {
    diagnostics.push({
      file: m[1]!.trim(),
      line: Number(m[2]),
      col: Number(m[3]),
      severity: /warning/i.test(m[4]!) ? "warning" : "error",
      message: m[4]!.trim(),
      source,
    });
  }
  return diagnostics;
}

// Heuristic, not a real reporter integration — covers bun test's default reporter exactly (a
// `      at <anonymous> (file:line:col)` line immediately preceding the `(fail) name [dur]`
// marker, with an `error: ...` block above it) and approximates jest/vitest's failure markers
// (✕/×/FAIL) well enough that most failures land on the right file:line. Anything it misses still
// surfaces via index.ts's raw fallback rather than vanishing.
const STACK_LINE = /^\s*at .*\((.+):(\d+):(\d+)\)\s*$/;
const FAIL_MARKER = /^\(fail\)\s+(.+?)(?:\s*\[[\d.]+m?s\])?\s*$|^\s*(?:✕|×)\s+(.+)$|^FAIL\s+(.+)$/;

export function parseTestOutput(output: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  let pendingLocation: { file: string; line: number; col: number } | null = null;
  let pendingMessage: string[] = [];
  let collecting = false;

  for (const line of output.split("\n")) {
    const stackMatch = line.match(STACK_LINE);
    if (stackMatch) {
      pendingLocation = { file: stackMatch[1]!, line: Number(stackMatch[2]), col: Number(stackMatch[3]) };
      continue;
    }
    if (/^error: /.test(line.trim())) {
      collecting = true;
      pendingMessage = [line.trim()];
      continue;
    }
    if (collecting && line.trim().length > 0) {
      pendingMessage.push(line.trim());
      continue;
    }
    if (line.trim().length === 0) collecting = false;

    const failMatch = line.match(FAIL_MARKER);
    if (failMatch) {
      const testName = (failMatch[1] ?? failMatch[2] ?? failMatch[3] ?? "").trim();
      const message = pendingMessage.length ? pendingMessage.join(" ") : "test failed";
      diagnostics.push({
        file: pendingLocation?.file ?? "",
        line: pendingLocation?.line ?? 0,
        col: pendingLocation?.col,
        severity: "error",
        message: testName ? `${testName}: ${message}` : message,
        source: "test",
      });
      pendingLocation = null;
      pendingMessage = [];
      collecting = false;
    }
  }
  return diagnostics;
}
