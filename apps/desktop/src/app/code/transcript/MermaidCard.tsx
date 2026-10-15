import { useEffect, useState } from "react";

/* A ```mermaid fence, drawn inside the same card as the other fences (docs/CODE_REDESIGN_PLAN.md CR6:
   "Mermaid stays, inside the same card"). mermaid is loaded on first use. */

export function MermaidCard({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const dark = document.documentElement.getAttribute("data-rmode") !== "light";
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", securityLevel: "strict" });
        const { svg: out } = await mermaid.render(`mermaid-${Math.random().toString(36).slice(2, 9)}`, code);
        if (!cancelled) {
          setSvg(out);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  return (
    <div className="r-card">
      <div className="r-card-head">
        <span>{error ? "Diagram (couldn't draw it)" : "Diagram"}</span>
      </div>
      {error ? (
        <pre className="r-mermaid-src">{code}</pre>
      ) : svg ? (
        <div className="r-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="r-mermaid r-muted">Drawing the diagram…</div>
      )}
    </div>
  );
}
