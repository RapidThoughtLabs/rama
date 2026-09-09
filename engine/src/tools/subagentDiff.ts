import { runGit } from "./gitShared";

// docs/PROMPT_STACK_PLAN.md §6.4, Phase PS5 — `review` and `test` both get "diff + repo" context.
// Uncommitted changes (staged + unstaged) against HEAD by default — "review/test what I just
// did" — or an explicit ref for a wider comparison (e.g. a base branch).
const DIFF_MAX_CHARS = 30_000;

export async function getWorkingDiff(projectPath: string, against?: string): Promise<{ diff: string; empty: boolean }> {
  const primary = await runGit(projectPath, ["diff", against ?? "HEAD"]);
  // `HEAD` doesn't resolve in a fresh repo with no commits yet — fall back to a plain `git diff`
  // (working tree vs. index) rather than surfacing git's stderr as if it were "no changes".
  const { output } = primary.exitCode === 0 ? primary : await runGit(projectPath, ["diff"]);
  const diff = output.trim();
  return { diff, empty: diff.length === 0 };
}

export function truncateDiff(diff: string): string {
  return diff.length > DIFF_MAX_CHARS ? `${diff.slice(0, DIFF_MAX_CHARS)}\n\n… (diff truncated, ${diff.length} chars total — narrow with \`against\`)` : diff;
}
