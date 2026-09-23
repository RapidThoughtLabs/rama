import { useState, useEffect } from "react";
import { highlightCode } from "../mission-control/panes/syntax";
import { FileIcon } from "@rama/ui";
import { isPathShape } from "./PathLink";

interface CodeFenceProps {
  code: string;
  lang?: string;
}

function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function renderDiagram() {
      try {
        const mermaidModule = await import("mermaid");
        const mermaid = mermaidModule.default;
        const isDark = document.documentElement.getAttribute("data-rmode") !== "light";
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? "dark" : "default",
          securityLevel: "loose",
        });
        const id = `mermaid-${Math.random().toString(36).slice(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    }

    void renderDiagram();

    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="rama-code-fence rama-breakout">
        <div className="rama-code-fence-header">
          <span className="rama-code-fence-lang">mermaid (syntax error)</span>
        </div>
        <pre className="rama-code-fence-body" style={{ color: "var(--bad)", margin: 0 }}>
          {code}
        </pre>
      </div>
    );
  }

  if (!svg) {
    return (
      <div className="rama-code-fence rama-breakout" style={{ padding: "14px", color: "rgba(var(--ink), 0.5)", textAlign: "center" }}>
        rendering diagram…
      </div>
    );
  }

  return (
    <div
      className="rama-mermaid-wrap rama-breakout"
      style={{
        margin: "10px 0",
        padding: "12px",
        background: "rgba(var(--ink), 0.02)",
        border: "1px solid rgba(var(--ink), 0.08)",
        borderRadius: 6,
        overflowX: "auto",
        display: "flex",
        justifyContent: "center",
      }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export function CodeFence({ code, lang = "" }: CodeFenceProps) {
  const [copied, setCopied] = useState(false);

  const cleanLang = lang.trim().toLowerCase();
  if (cleanLang === "mermaid") {
    return <MermaidBlock code={code} />;
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const lines = highlightCode(code, lang);
  const isPath = isPathShape(lang);

  return (
    <div className="rama-code-fence rama-breakout">
      <div className="rama-code-fence-header">
        <span className="rama-code-fence-lang">
          {isPath && <FileIcon path={lang.trim()} width={13} height={13} />}
          <span>{lang || "plain text"}</span>
        </span>
        <button type="button" className="rama-code-fence-copy" onClick={handleCopy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className="rama-code-fence-body">
        {lines.map((lineHtml, idx) => (
          <div
            key={idx}
            className="rama-code-line"
            dangerouslySetInnerHTML={{ __html: lineHtml || "&nbsp;" }}
          />
        ))}
      </div>
    </div>
  );
}
