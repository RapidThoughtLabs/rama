import { useEffect, useState } from "react";
import type { ArtifactDTO, ArtifactKind } from "@rama/protocol";
import { fetchArtifactContent } from "../engine/client";
import { useSessionData } from "./data/SessionProvider";

const KIND_GLYPH: Record<ArtifactKind, string> = { diff: "±", code: "◇", terminal: "▸", doc: "▤", file: "⬚" };

function formatMetaLine(a: ArtifactDTO): string {
  if (a.kind === "code" && typeof a.meta.lines === "number") return `${a.kind} · ${a.meta.lines} lines`;
  if (a.kind === "terminal" && typeof a.meta.matches === "number") return `${a.kind} · ${a.meta.matches} matches`;
  if (a.kind === "terminal" && typeof a.meta.entries === "number") return `${a.kind} · ${a.meta.entries} entries`;
  if (a.kind === "diff" && typeof a.meta.added === "number" && typeof a.meta.removed === "number") {
    return `${a.kind} · +${a.meta.added} −${a.meta.removed}`;
  }
  return a.kind;
}

function formatBadge(a: ArtifactDTO): string {
  if (a.status === "streaming") return "streaming";
  if (a.kind === "terminal" && typeof a.meta.exitCode === "number") {
    return a.meta.exitCode === 0 ? "ok" : `exit ${a.meta.exitCode}`;
  }
  return "";
}

function parseDiffLines(text: string): { n: string; t: string; kind: "ctx" | "add" | "del" }[] {
  return text.split("\n").map((line, i) => {
    const prefix = line[0];
    const kind = prefix === "+" ? "add" : prefix === "-" ? "del" : "ctx";
    return { n: String(i + 1), t: line.slice(1), kind };
  });
}

export function ArtifactsPanel() {
  const { artifacts, artifactBuffers } = useSessionData();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [content, setContent] = useState("");

  useEffect(() => {
    if (artifacts.length === 0) {
      setActiveId(null);
    } else if (!activeId || !artifacts.some((a) => a.id === activeId)) {
      setActiveId(artifacts[0].id);
    }
  }, [artifacts, activeId]);

  const active = artifacts.find((a) => a.id === activeId) ?? null;

  useEffect(() => {
    if (!active) {
      setContent("");
      return;
    }
    if (active.status === "streaming") {
      setContent(artifactBuffers[active.id] ?? "");
      return;
    }
    let cancelled = false;
    fetchArtifactContent(active.id)
      .then((res) => {
        if (!cancelled) setContent(res.content);
      })
      .catch((err) => {
        console.error("[rama] failed to fetch artifact content", err);
      });
    return () => {
      cancelled = true;
    };
  }, [active, artifactBuffers]);

  return (
    <div className="rama-artifacts-panel">
      <div className="rama-artifacts-header">
        <span className="t-label">artifacts</span>
        <span className="rama-badge rama-badge-accent">{artifacts.length}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 9.5, color: "var(--accent-bright, var(--accent))", cursor: "pointer" }}>all</span>
        <span style={{ fontSize: 9.5, color: "rgba(var(--ink),0.35)", cursor: "pointer" }}>files</span>
        <span style={{ fontSize: 9.5, color: "rgba(var(--ink),0.35)", cursor: "pointer" }}>tools</span>
      </div>

      <div className="rama-artifacts-list">
        {artifacts.length === 0 && (
          <div style={{ padding: "8px 12px", fontSize: 11, color: "rgba(var(--ink),0.4)" }}>no artifacts yet.</div>
        )}
        {artifacts.map((a) => (
          <div
            key={a.id}
            role="option"
            aria-selected={a.id === activeId}
            className="rama-artifact-row"
            onClick={() => setActiveId(a.id)}
          >
            <span className="rama-artifact-glyph">{KIND_GLYPH[a.kind]}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="rama-artifact-name">{a.name}</div>
              <div className="rama-artifact-meta">{formatMetaLine(a)}</div>
            </div>
            {formatBadge(a) && <span className="rama-artifact-badge">{formatBadge(a)}</span>}
          </div>
        ))}
      </div>

      {active && (
        <>
          <div className="rama-artifact-preview-toolbar">
            <span
              style={{
                fontSize: 11,
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
                fontSize: 8.5,
                color: "rgba(var(--ink),0.4)",
                border: "1px solid rgba(var(--ink),0.1)",
                borderRadius: 99,
                padding: "1px 7px",
              }}
            >
              {active.kind}
            </span>
            <span style={{ flex: 1 }} />
            <span title="Copy" style={{ fontSize: 11, color: "rgba(var(--ink),0.4)", cursor: "pointer" }}>
              ⧉
            </span>
            <span title="Open in editor" style={{ fontSize: 11, color: "rgba(var(--ink),0.4)", cursor: "pointer" }}>
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
                  fontSize: 12,
                  color: "rgba(var(--ink),0.75)",
                }}
              >
                {content}
              </pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
