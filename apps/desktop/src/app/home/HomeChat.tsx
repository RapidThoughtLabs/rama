import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatBlock, MessageDTO, ToolCallDTO } from "@rama/protocol";
import { ActRow, Acts, Icon, TurnActions, TurnUser, Working, byline } from "@rama/ui";
import { uploadHomeAttachment } from "../../engine/client";
import { useHomeChats } from "../data/HomeChatsProvider";
import { useNavigation } from "../data/NavigationProvider";
import { useSessionData } from "../data/SessionProvider";
import { chipFor } from "./attachments";
import { WHALE_VERBS, errorSentence, liveThinkingAct, thinkingAct, toolAct, workingVerb, type Act } from "./actLabels";
import { HomeComposer, useModelChoices } from "./HomeComposer";
import { HomeMarkdown } from "./HomeMarkdown";

/* An open Home chat — HOME_REDESIGN_PLAN.md Phase HD6 (mock:L282-360, 1605-1630). The scroller,
   the transcript column and the dock with the reply composer.

   The engine stores one assistant row per step (CONTEXT_BUDGET_PLAN CB6), so an AI turn is every
   assistant message between two user messages, its blocks taken in stream order: each run of
   activity (thinking, tool calls) becomes one group of plain-language rows, each text block a
   prose block. While the run hasn't written any text yet, the working line sits under the last
   row.

   Scrolling (D4): the chat opens at the bottom, sending scrolls to the bottom, and streaming
   sticks to the bottom unless the reader has scrolled up more than 80px. */

const RUNNING = new Set(["thinking", "streaming", "tool", "waiting_permission"]);
const STICK_PX = 80;

type Turn = { kind: "user"; msg: MessageDTO } | { kind: "note"; msg: MessageDTO } | { kind: "ai"; msgs: MessageDTO[]; pending: boolean };

function groupTurns(messages: MessageDTO[]): Turn[] {
  const turns: Turn[] = [];
  for (const msg of messages) {
    if (msg.role === "user") turns.push({ kind: "user", msg });
    else if (msg.role === "system") turns.push({ kind: "note", msg });
    else {
      const last = turns[turns.length - 1];
      const pending = msg.id.startsWith("pending-");
      if (last?.kind === "ai") {
        last.msgs.push(msg);
        last.pending ||= pending;
      } else turns.push({ kind: "ai", msgs: [msg], pending });
    }
  }
  return turns;
}

export function HomeChat() {
  const nav = useNavigation();
  const { homeChats, setModel, setWebSearch } = useHomeChats();
  const { messages, toolCalls, status, errorMessage, sendUserTurn, interrupt, retryTurn } = useSessionData();
  const { resolve } = useModelChoices();
  const chat = homeChats.find((c) => c.id === nav.homeChatId) ?? null;
  const [text, setText] = useState("");
  // HD7 — files waiting to go with the next reply, uploaded on Send.
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const running = RUNNING.has(status.state);

  async function send() {
    if (uploading) return;
    const chatId = chat?.id;
    if (!chatId) return;
    setNotice(null);
    let attachmentIds: string[] = [];
    if (files.length) {
      setUploading(true);
      try {
        attachmentIds = (await Promise.all(files.map((f) => uploadHomeAttachment(chatId, f)))).map((a) => a.id);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
        return;
      } finally {
        setUploading(false);
      }
    }
    stick.current = true;
    sendUserTurn(text.trim(), attachmentIds);
    setText("");
    setFiles([]);
  }

  const turns = useMemo(() => groupTurns(messages), [messages]);
  const calls = useMemo(() => new Map(toolCalls.map((c) => [c.id, c])), [toolCalls]);
  const awaitingRun = running && turns[turns.length - 1]?.kind !== "ai";

  const bylineFor = (msgs: MessageDTO[]) => {
    const from = msgs.find((m) => m.model) ?? null;
    const m = resolve({ providerId: from?.providerId ?? chat?.providerId ?? null, modelId: from?.model ?? chat?.model ?? null });
    return m ? byline(m.name, m.place, m.via) : "";
  };

  // ── Scrolling ──
  const scrollerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opened = useRef(false);
  const userTurns = messages.filter((m) => m.role === "user").length;
  const lastUserTurns = useRef(userTurns);
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || messages.length === 0) return;
    const sent = userTurns > lastUserTurns.current;
    lastUserTurns.current = userTurns;
    if (!opened.current || sent) stick.current = true;
    opened.current = true;
    if (stick.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <section className="r-view r-home-chat">
      <div
        className="r-scroller"
        ref={scrollerRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
        }}
      >
        <div className="r-transcript">
          {turns.map((turn, i) =>
            turn.kind === "user" ? (
              <TurnUser key={i} text={turn.msg.content ?? ""} attach={turn.msg.attachments?.map(chipFor)} />
            ) : turn.kind === "note" ? (
              <p key={i} className="r-notice">
                {turn.msg.content}
              </p>
            ) : (
              <AiTurn
                key={i}
                msgs={turn.msgs}
                pending={turn.pending}
                calls={calls}
                byline={bylineFor(turn.msgs)}
                onRetry={running ? undefined : () => retryTurn(userTurnBefore(turns, i))}
              />
            ),
          )}
          {/* Between Send and the run's first event. */}
          {awaitingRun && (
            <div className="r-turn-ai">
              <WorkingLine call={null} />
            </div>
          )}
          {status.state === "error" || (errorMessage && !running) ? (
            <p className="r-notice">
              {errorSentence(errorMessage)}
              <button className="r-mini" onClick={() => retryTurn()}>
                <Icon name="retry" />
                <span>Try again</span>
              </button>
            </p>
          ) : null}
        </div>
      </div>
      <div className="r-dock">
        <div className="r-composer-wrap">
          <HomeComposer
            placeholder="Reply to Rama"
            value={text}
            onChange={setText}
            onSubmit={() => void send()}
            running={running}
            onStop={interrupt}
            webSearch={chat?.webSearch ?? false}
            onWebSearchChange={(on) => {
              if (chat) setWebSearch(chat.id, on).catch((err) => console.error("[rama] failed to switch web search", err));
            }}
            files={files}
            onFilesChange={(next) => {
              setNotice(null);
              setFiles(next);
            }}
            notice={notice}
            selected={{ providerId: chat?.providerId ?? null, modelId: chat?.model ?? null }}
            onPickModel={(providerId, model) => {
              if (chat) setModel(chat.id, providerId, model).catch((err) => console.error("[rama] failed to switch model", err));
            }}
          />
        </div>
      </div>
    </section>
  );
}

/** Which user message an AI turn answers, as its position among the user messages (for Try again). */
function userTurnBefore(turns: Turn[], index: number): number | undefined {
  let n = -1;
  let found = false;
  for (let i = 0; i < index; i++) {
    if (turns[i]!.kind === "user") {
      n++;
      found = true;
    }
  }
  return found ? n : undefined;
}

/* ═══ AI turn ═══ */

type Segment = { kind: "acts"; acts: { key: string; act: Act }[] } | { kind: "prose"; key: string; text: string };

function AiTurn({ msgs, pending, calls, byline, onRetry }: { msgs: MessageDTO[]; pending: boolean; calls: Map<string, ToolCallDTO>; byline: string; onRetry?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const blocks = useMemo(() => msgs.flatMap(blocksOf), [msgs]);
  const live = useLiveThinking(pending ? blocks : []);

  const segments: Segment[] = [];
  let running: ToolCallDTO | null = null;
  for (const [i, b] of blocks.entries()) {
    const key = `${b.stepIndex ?? 0}:${b.blockIndex ?? i}:${b.kind}`;
    if (b.kind === "text") {
      if (!b.text.trim()) continue;
      const prev = segments[segments.length - 1];
      if (prev?.kind === "prose") prev.text += `\n\n${b.text}`;
      else segments.push({ kind: "prose", key, text: b.text });
      continue;
    }
    let act: Act | null = null;
    if (b.kind === "thinking") {
      const isLive = pending && b.durationMs == null && i === blocks.length - 1;
      if (isLive) act = liveThinkingAct(b.text, live.elapsed(key));
      else if (b.text.trim() || b.durationMs != null) act = thinkingAct(b.text, b.durationMs);
    } else {
      const call = calls.get(b.callId);
      // A call still running shows in the working line ("Reading lease.pdf"), not as a row.
      if (call && call.ok === null && pending) running = call;
      else if (call) act = toolAct(call);
    }
    if (!act) continue;
    const prev = segments[segments.length - 1];
    if (prev?.kind === "acts") prev.acts.push({ key, act });
    else segments.push({ kind: "acts", acts: [{ key, act }] });
  }
  const wrote = segments.some((s) => s.kind === "prose");

  // mock:L2097 — Copy takes the turn's prose as it reads.
  const proseText = () =>
    Array.from(ref.current?.querySelectorAll<HTMLElement>(".r-prose") ?? [])
      .map((el) => el.innerText.trim())
      .join("\n\n");

  return (
    <div className="r-turn-ai" ref={ref}>
      {segments.map((s, i) =>
        s.kind === "acts" ? (
          <Fragment key={s.acts[0]!.key}>
            <Acts>
              {s.acts.map(({ key, act }) => (
                <ActRow key={key} icon={act.icon} label={act.label} meta={act.meta} metaBad={act.metaBad} body={<ActBodyView body={act.body} />} />
              ))}
            </Acts>
            {pending && !wrote && i === segments.length - 1 && <WorkingLine call={running} />}
          </Fragment>
        ) : (
          <div key={s.key} className="r-prose">
            <HomeMarkdown content={s.text} />
          </div>
        ),
      )}
      {pending && !wrote && segments[segments.length - 1]?.kind !== "acts" && <WorkingLine call={running} />}
      {!pending && <TurnActions copyText={proseText} onRetry={onRetry} byline={byline} />}
    </div>
  );
}

function blocksOf(m: MessageDTO): ChatBlock[] {
  if (m.blocks?.length) return m.blocks;
  return m.content ? [{ kind: "text", text: m.content }] : [];
}

function ActBodyView({ body }: { body: Act["body"] }) {
  if (!body) return null;
  if (body.kind === "text") return <p>{body.text}</p>;
  return (
    <ol>
      {body.items.map((it, i) => (
        <li key={i}>
          {it.title}
          {it.source && (
            <>
              {" "}
              <span>{it.source}</span>
            </>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Seconds since each live thinking block was first seen, ticking once a second while one is. */
function useLiveThinking(blocks: ChatBlock[]) {
  const seen = useRef(new Map<string, number>());
  const [, tick] = useState(0);
  const anyLive = blocks.some((b) => b.kind === "thinking" && b.durationMs == null);
  useEffect(() => {
    if (!anyLive) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [anyLive]);
  return {
    elapsed(key: string) {
      if (!seen.current.has(key)) seen.current.set(key, Date.now());
      return Date.now() - seen.current.get(key)!;
    },
  };
}

/** The working line: the running tool in the present tense, otherwise a whale verb every 2s. */
function WorkingLine({ call }: { call: ToolCallDTO | null }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (call) return;
    const t = setInterval(() => setI((n) => (n + 1) % WHALE_VERBS.length), 2000);
    return () => clearInterval(t);
  }, [call]);
  return <Working verb={call ? workingVerb(call) : WHALE_VERBS[i]!} />;
}
