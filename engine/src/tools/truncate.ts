// docs/TOOL_LAYER_PLAN.md §5.5 — "truncation changes from head-only to head+tail: a failing
// test run's summary is almost always at the end." Shared by every tool that caps model-facing
// output (bash, git diff/show, check) so the ratio and marker stay consistent across all of them.
const HEAD_RATIO = 0.3;

export function headTailTruncate(text: string, maxChars: number): { content: string; truncated: boolean } {
  if (text.length <= maxChars) return { content: text, truncated: false };
  const headChars = Math.floor(maxChars * HEAD_RATIO);
  const tailChars = maxChars - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  const omitted = text.length - maxChars;
  return { content: `${head}\n… [${omitted} chars omitted] …\n${tail}`, truncated: true };
}
