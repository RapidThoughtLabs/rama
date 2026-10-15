import { useRef } from "react";
import type { PermissionScope } from "@rama/protocol";
import type { ReactNode } from "react";
import { Acts, Icon, TurnActions, TurnUser } from "@rama/ui";
import { HomeMarkdown, type MarkdownHooks } from "../../home/HomeMarkdown";
import { chipFor } from "../../home/attachments";
import type { Block, Turn } from "./buildTranscript";
import type { AskContext } from "./permissionCopy";
import { AskCard, ChangesCard, ClarifyCard, PlanCard } from "./Cards";
import { MermaidCard } from "./MermaidCard";
import { isPathShape } from "./pathShape";
import { CodeActRow, PathPill } from "./RowView";
import type { RowModel } from "./rows";

/* The turns of the Code transcript — docs/CODE_REDESIGN_PLAN.md CR6 (mock:L1698-1732). Draws what
   buildTranscript() says: a user bubble, an AI turn of rows (grouped into `.r-acts`), prose, cards
   and the turn's actions, or a centred notice. */

/** Inline code that names a *file* in the project becomes a path pill. Folders (`apps/desktop`),
 *  `~/…`, absolute paths and globs stay code, as the mockup draws them (mock:L1362, 1386). */
const FILE_NAME = /\.[A-Za-z0-9]+$/;
const PROSE_HOOKS: MarkdownHooks = {
  inlineCode: (code) => {
    const c = code.trim();
    return isPathShape(c) && FILE_NAME.test(c) && !c.startsWith("~") && !c.startsWith("/") && !/[*?{}]/.test(c) ? <PathPill path={c} /> : null;
  },
  fence: (lang, code) => (lang === "mermaid" ? <MermaidCard code={code} /> : null),
};

export interface TurnHandlers {
  chatId: string | null;
  askContext: AskContext;
  onAnswer: (reqId: string, approve: boolean, scope?: PermissionScope) => void;
  onUndo: () => void;
  onDismissNote: (id: string) => void;
}

function renderBlocks(blocks: Block[], h: TurnHandlers): ReactNode[] {
  const out: ReactNode[] = [];
  let acts: RowModel[] = [];
  const flush = () => {
    if (!acts.length) return;
    out.push(
      <Acts key={`acts:${acts[0]!.key}`}>
        {acts.map((r) => (
          <CodeActRow key={r.key} row={r} />
        ))}
      </Acts>,
    );
    acts = [];
  };
  for (const b of blocks) {
    if (b.k === "row") {
      acts.push(b.row);
      continue;
    }
    flush();
    switch (b.k) {
      case "prose":
        out.push(
          <div key={b.key} className="r-prose">
            <HomeMarkdown content={b.markdown} hooks={PROSE_HOOKS} />
          </div>,
        );
        break;
      case "plan":
        out.push(<PlanCard key={b.key} items={b.items} />);
        break;
      case "changes":
        out.push(<ChangesCard key={b.key} files={b.files} added={b.added} removed={b.removed} undoable={b.undoable} onUndo={h.onUndo} />);
        break;
      case "ask":
        out.push(<AskCard key={b.key} request={b.request} chatId={h.chatId} context={h.askContext} onAnswer={(approve, scope) => h.onAnswer(b.request.reqId, approve, scope)} />);
        break;
      case "clarify":
        out.push(<ClarifyCard key={b.key} questions={b.questions} />);
        break;
    }
  }
  flush();
  return out;
}

export function TurnView({
  turn,
  handlers,
  byline,
  onRetry,
  working,
}: {
  turn: Turn;
  handlers: TurnHandlers;
  byline: string;
  onRetry?: () => void;
  /** The working line, when this is the turn a run is still writing. */
  working?: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  if (turn.k === "user") {
    return <TurnUser text={turn.text} attach={turn.message.attachments?.map(chipFor)} />;
  }
  if (turn.k === "note") {
    return (
      <p className="r-notice">
        {turn.text}
        <button type="button" className="r-notice-x" aria-label="Dismiss" title="Dismiss" onClick={() => handlers.onDismissNote(turn.id)}>
          <Icon name="x" />
        </button>
      </p>
    );
  }

  // mock:L2097 — Copy takes the turn's prose as it reads.
  const proseText = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>(".r-prose") ?? [])
      .map((el) => el.innerText.trim())
      .join("\n\n");

  return (
    <div className="r-turn-ai" ref={ref}>
      {renderBlocks(turn.blocks, handlers)}
      {working}
      {!turn.pending && !turn.waiting && !working && <TurnActions copyText={proseText} onRetry={onRetry} byline={byline} />}
    </div>
  );
}
