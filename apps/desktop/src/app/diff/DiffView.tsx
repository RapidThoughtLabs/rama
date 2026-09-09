// docs/WORKSPACE_PANES_PLAN.md Phase W0 — standalone unified-diff renderer.
// Pure view component: takes diff text, renders old/new line numbers + diff markers.
// Does not fetch, does not know about artifacts, and does not know about git.

function parseDiffLines(text: string): { oldNum: number | null; newNum: number | null; t: string; kind: "ctx" | "add" | "del" | "hunk" }[] {
  let oldNum = 0;
  let newNum = 0;
  return text.split("\n").map((line) => {
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNum = parseInt(m[1]!, 10) - 1;
        newNum = parseInt(m[2]!, 10) - 1;
      }
      return { oldNum: null, newNum: null, t: line, kind: "hunk" };
    }
    const prefix = line[0];
    const kind = prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
    if (kind !== "add") oldNum++;
    if (kind !== "del") newNum++;
    return { oldNum: kind === "add" ? null : oldNum, newNum: kind === "del" ? null : newNum, t: line.slice(1), kind };
  });
}

export function DiffView({ diff }: { diff: string }) {
  const lines = parseDiffLines(diff);
  return (
    <div className="rama-diff-body">
      {lines.map((l, i) => (
        <div
          key={i}
          className={`rama-diff-line ${
            l.kind === "add" ? "rama-diff-add" : l.kind === "del" ? "rama-diff-del" : l.kind === "hunk" ? "rama-diff-hunk" : "rama-diff-ctx"
          }`}
        >
          <span className="rama-diff-line-num rama-diff-line-num-old">{l.oldNum ?? ""}</span>
          <span className="rama-diff-line-num rama-diff-line-num-new">{l.newNum ?? ""}</span>
          <span className="rama-diff-line-marker">
            {l.kind === "add" ? "+" : l.kind === "del" ? "−" : l.kind === "hunk" ? "⋯" : ""}
          </span>
          <span className="rama-diff-line-text">{l.t}</span>
        </div>
      ))}
    </div>
  );
}
