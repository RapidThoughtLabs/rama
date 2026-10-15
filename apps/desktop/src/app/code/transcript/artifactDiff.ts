/* The engine stores an edit's diff artifact as the whole file, every line prefixed `+`, `-` or a
   space (engine/src/tools/diffFormat.ts) — no hunk headers. The transcript's diff card shows what
   changed, not the file, so this cuts it into hunks with three lines of context around each change
   and writes the `@@ -a,b +c,d @@` headers `Diff` reads. Text that already has headers (the
   Changes pane's own diffs) passes through. */

const CONTEXT = 3;

export function toUnified(text: string): string {
  if (/^@@ /m.test(text)) return text;
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  // Old and new line numbers at the start of each line.
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = 1;
  let n = 1;
  for (const l of lines) {
    oldAt.push(o);
    newAt.push(n);
    if (l[0] !== "+") o++;
    if (l[0] !== "-") n++;
  }

  const changed = lines.flatMap((l, i) => (l[0] === "+" || l[0] === "-" ? [i] : []));
  if (!changed.length) return "";

  // Merge each change's window (±CONTEXT lines) into ranges.
  const ranges: [number, number][] = [];
  for (const i of changed) {
    const from = Math.max(0, i - CONTEXT);
    const to = Math.min(lines.length - 1, i + CONTEXT);
    const last = ranges[ranges.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else ranges.push([from, to]);
  }

  return ranges
    .map(([from, to]) => {
      const body = lines.slice(from, to + 1);
      const oldCount = body.filter((l) => l[0] !== "+").length;
      const newCount = body.filter((l) => l[0] !== "-").length;
      return `@@ -${oldCount ? oldAt[from] : oldAt[from] - 1},${oldCount} +${newCount ? newAt[from] : newAt[from] - 1},${newCount} @@\n${body.join("\n")}`;
    })
    .join("\n");
}
