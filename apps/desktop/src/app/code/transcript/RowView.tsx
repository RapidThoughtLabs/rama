import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArtifactDTO } from "@rama/protocol";
import { Icon } from "@rama/ui";
import { fetchArtifactContent } from "../../../engine/client";
import { baseName } from "../workspace/parts";
import { Diff } from "../workspace/Diff";
import { toUnified } from "./artifactDiff";
import type { BodyPart, MetaPart, RowModel, Seg } from "./rows";

/* One activity row and its body — docs/CODE_REDESIGN_PLAN.md CR6 (mock:L304-319, 409-420, 1624-1630).
   The kit's ActRow takes any body but keeps its own open state; Code's running row has to open
   itself and close when its call finishes, so this draws the same `.r-act-btn` / `.r-act-body`
   markup with the open state held here. Bodies mount only while open, so a long transcript's diffs
   and output cost nothing until someone asks. */

export interface TranscriptEnv {
  artifacts: ReadonlyMap<string, ArtifactDTO>;
  /** Live artifact text, appended to as a run streams. */
  buffers: Readonly<Record<string, string>>;
  goto: (spec: string) => void;
}
export const TranscriptEnvContext = createContext<TranscriptEnv | null>(null);
function useEnv(): TranscriptEnv {
  const v = useContext(TranscriptEnvContext);
  if (!v) throw new Error("TranscriptEnvContext is missing");
  return v;
}

/** `.path` — a file named in a row or in prose; opens in the Files pane (mock:L422-428, 1337). */
export function PathPill({ path }: { path: string }) {
  const env = useEnv();
  return (
    <button type="button" className="r-path" title={path} onClick={() => env.goto(`files:${path}`)}>
      {baseName(path) || path}
    </button>
  );
}

export function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) =>
        typeof s === "string" ? (
          s
        ) : "b" in s ? (
          <b key={i}>{s.b}</b>
        ) : "i" in s ? (
          <em key={i}>{s.i}</em>
        ) : "code" in s ? (
          <code key={i}>{s.code}</code>
        ) : (
          <PathPill key={i} path={s.path} />
        ),
      )}
    </>
  );
}

function Meta({ parts }: { parts: MetaPart[] }) {
  if (!parts.length) return null;
  return (
    <span className="meta">
      {parts.map((p, i) => (
        <span key={i} className={p.tone ? `t-${p.tone}` : undefined}>
          {i > 0 ? " " : ""}
          {p.text}
        </span>
      ))}
    </span>
  );
}

export function CodeActRow({ row }: { row: RowModel }) {
  const [open, setOpen] = useState(row.live);
  const touched = useRef(false);
  // The live row opens by itself and closes when its call finishes — unless the reader took over.
  const wasLive = useRef(row.live);
  useEffect(() => {
    if (touched.current) return;
    if (row.live && !wasLive.current) setOpen(true);
    if (!row.live && wasLive.current) setOpen(false);
    wasLive.current = row.live;
  }, [row.live]);

  const hasBody = row.body.length > 0;
  return (
    <div>
      <button
        type="button"
        className="r-act-btn"
        aria-expanded={open}
        title={row.title}
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
      >
        <span className="dot">
          <Icon name={row.icon} />
        </span>
        <span>
          <Segs segs={row.label} />
        </span>
        <Meta parts={row.meta} />
        <Icon name="right" className="chev" />
      </button>
      <div className="r-act-body" hidden={!open}>
        {open && hasBody && row.body.map((part, i) => <Body key={i} part={part} live={row.live} />)}
      </div>
    </div>
  );
}

function Body({ part, live }: { part: BodyPart; live: boolean }) {
  const env = useEnv();
  switch (part.k) {
    case "text":
      return <p>{part.text}</p>;
    case "list":
      return (
        <ul className="r-files">
          {part.items.map((it, i) => (
            <li key={i}>
              <span>{it.verb}</span>
              <span>
                <Segs segs={it.what} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "link":
      return (
        <button type="button" className="r-link" onClick={() => env.goto(part.goto)}>
          {part.label}
          <Icon name="right" />
        </button>
      );
    case "artifact":
      return part.artifactId ? <ArtifactBody id={part.artifactId} fallback={part.fallback} live={live} /> : part.fallback ? <p>{part.fallback}</p> : null;
  }
}

// Finished artifacts never change, so a collapsed-and-reopened row doesn't fetch twice.
const fetched = new Map<string, string>();

function ArtifactBody({ id, fallback, live }: { id: string; fallback?: string; live: boolean }): ReactNode {
  const env = useEnv();
  const art = env.artifacts.get(id);
  const streaming = art?.status === "streaming" || (live && !art);
  const [loaded, setLoaded] = useState<string | null>(fetched.get(id) ?? null);

  useEffect(() => {
    if (streaming || loaded !== null) return;
    let cancelled = false;
    fetchArtifactContent(id)
      .then((res) => {
        fetched.set(id, res.content);
        if (!cancelled) setLoaded(res.content);
      })
      .catch((err) => console.error("[rama] failed to fetch artifact content", err));
    return () => {
      cancelled = true;
    };
  }, [id, streaming, loaded]);

  const content = streaming ? (env.buffers[id] ?? "") : (loaded ?? env.buffers[id] ?? null);
  if (content === null) return <p className="r-muted">Loading…</p>;
  if (!content.trim()) return fallback ? <p>{fallback}</p> : null;

  const kind = art?.kind ?? "doc";
  if (kind === "diff") {
    const unified = toUnified(content);
    return unified ? (
      <div className="r-card r-code-card">
        <Diff diff={unified} path={art?.name ?? ""} />
      </div>
    ) : null;
  }
  if (kind === "terminal") {
    return (
      <div className="r-card r-code-card">
        <div className="r-term">{content.replace(/\n$/, "")}</div>
      </div>
    );
  }
  return <p>{content}</p>;
}
