import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Fluke } from "../../components/Fluke";
import { Icon, type IconName } from "../Icon";

/* Kit transcript primitives — HOME_REDESIGN_PLAN.md Phase HD6 (mock:L282-360, 1607-1630). Pure
   presentation: what a turn says, which rows it shows and what Try again means are the caller's.
   The Code plan builds its own blocks (diffs, terminal, permission cards) from the same pieces
   (§3 rule 3: ActRow takes any body, TurnActions takes a `hidden` flag). */

/** Copies text and reports "copied" for 1.4s (mock:L2096-2100). */
export function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [
    copied,
    (text: string) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    },
  ];
}

export interface AttachmentChip {
  icon: IconName;
  name: string;
  meta: string;
}

/** mock:L1607-1610 — the user's turn: an optional attachment above the bubble. A turn of files
 *  alone (HD7) has no bubble. */
export function TurnUser({ text, attach }: { text: string; attach?: AttachmentChip[] }) {
  return (
    <div className="r-turn-user">
      {attach?.map((a, i) => <Attachment key={i} chip={a} />)}
      {text && <div className="r-bubble">{text}</div>}
    </div>
  );
}

/** One attached file (mock:L1608). With `onRemove` (HD7: a file waiting in the composer, not in
 *  the mockup) it gains a ✕ at the end. */
export function Attachment({ chip, onRemove }: { chip: AttachmentChip; onRemove?: () => void }) {
  return (
    <div className={onRemove ? "r-attach removable" : "r-attach"}>
      <span className="r-attach-icon">
        <Icon name={chip.icon} />
      </span>
      <span>
        <b>{chip.name}</b>
        <small>{chip.meta}</small>
      </span>
      {onRemove && (
        <button type="button" className="r-attach-x" aria-label={`Remove ${chip.name}`} title="Remove" onClick={onRemove}>
          <Icon name="x" />
        </button>
      )}
    </div>
  );
}

/** A run of activity rows (mock:L304). */
export function Acts({ children }: { children: ReactNode }) {
  return <div className="r-acts">{children}</div>;
}

/** mock:L1624-1630 — one plain-language activity row, expandable when it has a body. */
export function ActRow({
  icon,
  label,
  meta,
  metaBad = false,
  body,
  defaultOpen = false,
}: {
  icon: IconName;
  label: ReactNode;
  meta?: ReactNode;
  /** The meta reads as a failure ("didn't work"), in the bad colour. */
  metaBad?: boolean;
  body?: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="r-act-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dot">
          <Icon name={icon} />
        </span>
        <span>{label}</span>
        {meta != null && meta !== "" && <span className={metaBad ? "meta bad" : "meta"}>{meta}</span>}
        <Icon name="right" className="chev" />
      </button>
      <div className="r-act-body" hidden={!open}>
        {body}
      </div>
    </div>
  );
}

/** mock:L338-341 — a card with a label and a Copy button. `code` gives the well-coloured code card
 *  (children: its `pre`); otherwise the children are a draft, set in prose type. Copy takes the
 *  body's plain text unless `copyText` says otherwise (mock:L2097). */
export function TranscriptCard({ label, code = false, copyText, children }: { label: string; code?: boolean; copyText?: () => string; children: ReactNode }) {
  const [copied, copy] = useCopied();
  const ref = useRef<HTMLDivElement>(null);
  const bodyText = () => ref.current?.querySelector<HTMLElement>(".r-draft-body, pre")?.innerText.trim() ?? "";
  return (
    <div ref={ref} className={code ? "r-card r-code-card" : "r-card"}>
      <div className="r-card-head">
        <span>{label}</span>
        <button className="r-mini" onClick={() => copy(copyText ? copyText() : bodyText())}>
          <Icon name="copy" />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      {code ? children : <div className="r-draft-body">{children}</div>}
    </div>
  );
}

/** mock:L1619-1623 — Copy, Try again and the byline under an AI turn. */
export function TurnActions({ copyText, onRetry, byline, hidden = false }: { copyText: () => string; onRetry?: () => void; byline: string; hidden?: boolean }) {
  const [copied, copy] = useCopied();
  if (hidden) return null;
  return (
    <div className="r-turn-actions">
      <button className="r-icon-btn" title="Copy" aria-label="Copy reply" onClick={() => copy(copyText())}>
        <Icon name={copied ? "check" : "copy"} />
      </button>
      {onRetry && (
        <button className="r-icon-btn" title="Try again" aria-label="Try again" onClick={onRetry}>
          <Icon name="retry" />
        </button>
      )}
      <span className="by">{byline}</span>
    </div>
  );
}

/** mock:L1618 — the bobbing fluke and what Rama is doing. */
export function Working({ verb }: { verb: string }) {
  return (
    <div className="r-working" role="status">
      <Fluke aria-hidden="true" role={undefined} aria-label={undefined} />
      <span>{verb}…</span>
    </div>
  );
}
