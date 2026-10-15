import { useContext, useEffect, useState } from "react";
import type { PermissionScope, TodoItem } from "@rama/protocol";
import { Icon } from "@rama/ui";
import { fetchChatChanges } from "../../../engine/client";
import { Delta, dirName, baseName } from "../workspace/parts";
import type { AskRequest, ChangedFile, ClarifyQuestion } from "./buildTranscript";
import { permissionCopy, type AskContext } from "./permissionCopy";
import { Segs, TranscriptEnvContext } from "./RowView";

/* The transcript's cards — docs/CODE_REDESIGN_PLAN.md CR6/CR7: the plan, what changed, a permission
   ask and a few questions (mock:L430-461, 1695-1714). Mockup markup with the r- prefix. */

/* ═══ Plan (mock:L430-440, 1695-1700) ═══ */

export function PlanCard({ items }: { items: TodoItem[] }) {
  const done = items.filter((i) => i.status === "done").length;
  const total = Math.max(items.length, 1);
  return (
    <div className="r-plan">
      <div className="r-plan-head">
        <b>Plan</b>
        <span>
          {done} of {items.length} done
        </span>
      </div>
      <div className="r-plan-bar">
        <i style={{ width: `${(done / total) * 100}%` }} />
      </div>
      <ul>
        {items.map((it, i) => (
          <li key={i} className={it.status === "pending" ? undefined : it.status} aria-current={it.status === "active" ? "step" : undefined}>
            <span className="r-tick-circle">{it.status === "done" && <Icon name="check" />}</span>
            <span>{it.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ═══ Changes (mock:L442-449, 1701-1707) ═══ */

export function ChangesCard({ files, added, removed, undoable, onUndo }: { files: ChangedFile[]; added: number; removed: number; undoable: boolean; onUndo: () => void }) {
  const env = useContext(TranscriptEnvContext);
  const [undone, setUndone] = useState(false);
  return (
    <div className={undone ? "r-card r-changes-card undone" : "r-card r-changes-card"}>
      <div className="r-card-head">
        <b>Changed {files.length === 1 ? "1 file" : `${files.length} files`}</b>
        <span>
          <Delta added={added} removed={removed} />
        </span>
      </div>
      {files.map((f) => (
        <button key={f.path} type="button" className="r-cf-row" onClick={() => env?.goto(`changes:${f.path}`)}>
          <Icon name={f.kind === "created" ? "file-plus" : f.kind === "deleted" ? "x" : "pencil"} />
          <span className="nm">
            {baseName(f.path)}
            <small>{dirName(f.path)}</small>
          </span>
          <span className="delta">
            <Delta added={f.added} removed={f.removed} />
          </span>
        </button>
      ))}
      <div className="r-card-foot">
        {undone ? (
          <span className="r-undone">Undone</span>
        ) : (
          <>
            <button type="button" className="r-btn r-btn-soft" onClick={() => env?.goto("changes")}>
              <Icon name="changes" />
              Review in Changes
            </button>
            {undoable && (
              <button
                type="button"
                className="r-btn r-btn-ghost"
                onClick={() => {
                  onUndo();
                  setUndone(true);
                }}
              >
                <Icon name="undo" />
                Undo these changes
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ═══ Permission ask (mock:L451-461, 1709-1714) ═══ */

export function AskCard({ request, chatId, context, onAnswer }: { request: AskRequest; chatId: string | null; context: AskContext; onAnswer: (approve: boolean, scope?: PermissionScope) => void }) {
  // A commit says how many files it records; that count lives in git, not in the request.
  const isCommit = request.tool === "git_write" && (request.input as { op?: string } | null)?.op === "commit";
  const [changedCount, setChangedCount] = useState<number | null>(null);
  useEffect(() => {
    if (!isCommit || !chatId) return;
    let cancelled = false;
    fetchChatChanges(chatId)
      .then((c) => {
        if (!cancelled) setChangedCount(c.entries.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [isCommit, chatId, request.reqId]);

  const copy = permissionCopy(request.tool, request.input, { ...context, changedCount });
  return (
    <div className="r-ask" role="group" aria-label="Permission request">
      <h4>
        <Icon name="shield" />
        {copy.title}
      </h4>
      {copy.code && <code>{copy.code}</code>}
      <p>
        <Segs segs={copy.body} />
      </p>
      <div className="row">
        <button type="button" className="r-btn" onClick={() => onAnswer(true)}>
          Allow once
        </button>
        <button type="button" className="r-btn r-btn-ghost" onClick={() => onAnswer(true, "chat")}>
          Always allow in this chat
        </button>
        <button type="button" className="r-btn r-btn-ghost" onClick={() => onAnswer(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

/* ═══ Clarify (not in the mockup, plan §9.11): a neutral ask ═══ */

export function ClarifyCard({ questions }: { questions: ClarifyQuestion[] }) {
  return (
    <div className="r-ask r-ask-neutral" role="group" aria-label="Questions from Rama">
      <h4>
        <Icon name="ask" />A few questions first
      </h4>
      <ol>
        {questions.map((q, i) => (
          <li key={i}>
            {q.question}
            {q.default && <span className="def"> (default: {q.default})</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
