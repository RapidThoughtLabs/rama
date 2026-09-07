import { useArtifactsPane } from "./ArtifactsPaneContext";

// Lifted unchanged from the old ArtifactsPanel.tsx (docs/MISSION_CONTROL_PLAN.md M1).
function parseDiffLines(text: string): { n: string; t: string; kind: "ctx" | "add" | "del" }[] {
  return text.split("\n").map((line, i) => {
    const prefix = line[0];
    const kind = prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
    return { n: String(i + 1), t: line.slice(1), kind };
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
              <span className="rama-diff-line-num">{l.n}</span>
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
