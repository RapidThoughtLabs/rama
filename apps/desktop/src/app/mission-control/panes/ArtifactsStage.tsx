import { useArtifactsPane } from "./ArtifactsPaneContext";

// Real old/new line-number gutters instead of one sequential counter (the old behaviour numbered
// every printed line 1, 2, 3... regardless of which side of the diff it came from — nothing like
// what a code editor's diff view shows). `formatUnifiedDiff` walks the whole file, not just
// changed hunks, so old/new stay in lockstep on context lines and diverge only across add/del runs.
function parseDiffLines(text: string): { oldNum: number | null; newNum: number | null; t: string; kind: "ctx" | "add" | "del" }[] {
  let oldNum = 0;
  let newNum = 0;
  return text.split("\n").map((line) => {
    const prefix = line[0];
    const kind = prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
    if (kind !== "add") oldNum++;
    if (kind !== "del") newNum++;
    return { oldNum: kind === "add" ? null : oldNum, newNum: kind === "del" ? null : newNum, t: line.slice(1), kind };
  });
}

export function ArtifactsStage() {
  const { active, content } = useArtifactsPane();

  if (!active) {
    return <div className="rama-mc-coming-soon">select an artifact.</div>;
  }

  return (
    <>
      <div className="rama-artifact-preview-toolbar">
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: "var(--fs-sm)",
            color: "rgb(var(--ink))",
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {active.name}
        </span>
        <span
          style={{
            fontSize: "var(--fs-micro)",
            color: "rgba(var(--ink),0.4)",
            border: "1px solid rgba(var(--ink),0.1)",
            borderRadius: 99,
            padding: "1px 7px",
          }}
        >
          {active.kind}
        </span>
        <span style={{ flex: 1 }} />
        <span title="Copy" style={{ fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.4)", cursor: "pointer" }}>
          ⧉
        </span>
        <span title="Open in editor" style={{ fontSize: "var(--fs-sm)", color: "rgba(var(--ink),0.4)", cursor: "pointer" }}>
          ↗
        </span>
      </div>

      <div className="rama-artifact-preview-body">
        {active.kind === "diff" ? (
          parseDiffLines(content).map((l, i) => (
            <div
              key={i}
              className={`rama-diff-line ${l.kind === "add" ? "rama-diff-add" : l.kind === "del" ? "rama-diff-del" : ""}`}
            >
              <span className="rama-diff-line-num rama-diff-line-num-old">{l.oldNum ?? ""}</span>
              <span className="rama-diff-line-num rama-diff-line-num-new">{l.newNum ?? ""}</span>
              <span className="rama-diff-line-marker">{l.kind === "add" ? "+" : l.kind === "del" ? "−" : ""}</span>
              <span className="rama-diff-line-text">{l.t}</span>
            </div>
          ))
        ) : (
          <pre
            style={{
              margin: 0,
              padding: "0 16px",
              whiteSpace: "pre-wrap",
              fontFamily: "inherit",
              fontSize: "var(--fs-md)",
              color: "rgba(var(--ink),0.75)",
            }}
          >
            {content}
          </pre>
        )}
      </div>
    </>
  );
}
