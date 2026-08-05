import { diffLines } from "diff";

// Serializes a diff as `+`/`-`/` `-prefixed lines — the same shape the frontend's existing
// diff renderer expects (see ArtifactsPanel.tsx), so no new preview format is needed.
export function formatUnifiedDiff(oldContent: string, newContent: string): { text: string; added: number; removed: number } {
  const changes = diffLines(oldContent, newContent);
  let added = 0;
  let removed = 0;
  const lines: string[] = [];

  for (const change of changes) {
    const prefix = change.added ? "+" : change.removed ? "-" : " ";
    const changeLines = change.value.split("\n");
    if (changeLines[changeLines.length - 1] === "") changeLines.pop();
    for (const line of changeLines) {
      lines.push(`${prefix}${line}`);
      if (change.added) added++;
      else if (change.removed) removed++;
    }
  }

  return { text: lines.join("\n"), added, removed };
}
