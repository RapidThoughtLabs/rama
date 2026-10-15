import type { ArtifactDTO, ChatBlock, MessageDTO, TodoItem, ToolCallDTO } from "@rama/protocol";
import { MUTATING, rowsFor, thinkingRow, type RowModel } from "./rows";

/* The Code transcript's view-model — docs/CODE_REDESIGN_PLAN.md CR6. Messages, tool calls and the
   pending permission go in; turns of typed blocks come out, and the components only draw them.
   Pure, so it is unit-tested (buildTranscript.test.ts).

   The engine stores one assistant row per model step (CONTEXT_BUDGET_PLAN CB6), so an AI turn is every
   assistant message between two user messages, its blocks taken in stream order.

   The plan card is derived from the `todo` tool's own calls (`set` makes a fresh list, `update`
   moves one item), so it renders live and after a reload with no extra subscription. */

export interface AskRequest {
  reqId: string;
  tool: string;
  input: unknown;
  risk?: "low" | "high";
}
export interface ClarifyQuestion {
  question: string;
  default?: string;
}
export interface ChangedFile {
  path: string;
  /** "created" for a new file, "deleted" for a removed one, otherwise "edited". */
  kind: "created" | "edited" | "deleted";
  added: number;
  removed: number;
}

export type Block =
  | { k: "prose"; key: string; markdown: string }
  | { k: "row"; key: string; row: RowModel }
  | { k: "plan"; key: string; items: TodoItem[] }
  | { k: "changes"; key: string; files: ChangedFile[]; added: number; removed: number; undoable: boolean }
  | { k: "ask"; key: string; request: AskRequest }
  | { k: "clarify"; key: string; questions: ClarifyQuestion[] };

export type Turn =
  | { k: "user"; key: string; text: string; message: MessageDTO }
  | { k: "note"; key: string; id: string; text: string }
  | {
      k: "ai";
      key: string;
      blocks: Block[];
      /** Still streaming (its last message is the client's `pending-` one). */
      pending: boolean;
      /** Ends on a permission ask — no turn actions under it. */
      waiting: boolean;
      /** At least one call in it changed files: Try again would run on top of those changes. */
      mutated: boolean;
      /** Position among the chat's user messages of the one this turn answers (for Try again). */
      answers: number | undefined;
      provider?: string;
      model?: string;
    };

export interface BuildInput {
  messages: MessageDTO[];
  toolCalls: ToolCallDTO[];
  artifacts: ArtifactDTO[];
  pendingPermission: AskRequest | null;
  /** Milliseconds a still-streaming thinking block has been open, keyed by its block key. */
  liveElapsed?: (key: string) => number;
  terminalTitle?: (id: string) => string | undefined;
}

const obj = <T,>(input: unknown): T => (input && typeof input === "object" ? input : {}) as T;

export function blocksOf(m: MessageDTO, byMessage: Map<string, ToolCallDTO[]>): ChatBlock[] {
  if (m.blocks?.length) return m.blocks;
  // A message from before blocks were stored: its thinking, then its tool calls, then its text.
  const out: ChatBlock[] = [];
  if (m.thinking) out.push({ kind: "thinking", text: m.thinking, durationMs: m.thinkingDurationMs ?? undefined });
  for (const c of byMessage.get(m.id) ?? []) out.push({ kind: "tool", callId: c.id });
  if (m.content) out.push({ kind: "text", text: m.content });
  return out;
}

const sameInput = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function buildTranscript(input: BuildInput): Turn[] {
  const { messages, toolCalls, artifacts, pendingPermission } = input;
  const calls = new Map(toolCalls.map((c) => [c.id, c]));
  const byMessage = new Map<string, ToolCallDTO[]>();
  for (const c of toolCalls) (byMessage.get(c.messageId) ?? byMessage.set(c.messageId, []).get(c.messageId)!).push(c);
  const rowCtx = { artifacts: new Map(artifacts.map((a) => [a.id, a])), terminalTitle: input.terminalTitle, state: {} as { host?: string } };

  // The call the permission ask is about: the latest unfinished call of that tool with that input.
  const asked = pendingPermission ? [...toolCalls].reverse().find((c) => c.ok === null && c.name === pendingPermission.tool && sameInput(c.input, pendingPermission.input)) : undefined;

  const turns: Turn[] = [];
  let userCount = 0;
  let plan: { items: TodoItem[] } | null = null;
  let group: MessageDTO[] = [];

  function flushAi() {
    if (!group.length) return;
    const msgs = group;
    group = [];
    turns.push(buildAi(msgs));
  }

  function buildAi(msgs: MessageDTO[]): Turn {
    const blocks: Block[] = [];
    let run: ToolCallDTO[] = [];
    let rows: RowModel[] = [];
    let mutated = false;
    const files = new Map<string, ChangedFile>();
    const key0 = msgs[0]!.id;
    const pending = msgs.some((m) => m.id.startsWith("pending-"));
    const push = (b: Block) => blocks.push(b);

    const flushRun = () => {
      if (run.length) rows.push(...rowsFor(run, rowCtx));
      run = [];
    };
    const flushRows = () => {
      flushRun();
      for (const row of rows) push({ k: "row", key: row.key, row });
      rows = [];
    };

    const all = msgs.flatMap((m) => blocksOf(m, byMessage).map((b, i) => ({ b, m, i })));
    for (const [n, { b, m, i }] of all.entries()) {
      const key = `${m.id}:${b.stepIndex ?? 0}:${b.blockIndex ?? i}:${b.kind}`;
      if (b.kind === "text") {
        if (!b.text.trim()) continue;
        flushRows();
        const prev = blocks[blocks.length - 1];
        if (prev?.k === "prose") prev.markdown += `\n\n${b.text}`;
        else push({ k: "prose", key, markdown: b.text });
        continue;
      }
      if (b.kind === "thinking") {
        const live = pending && b.durationMs == null && n === all.length - 1;
        if (!live && !b.text.trim() && b.durationMs == null) continue;
        flushRun();
        rows.push(thinkingRow(key, b.text, b.durationMs, live, live ? (input.liveElapsed?.(key) ?? 0) : 0));
        continue;
      }
      const call = calls.get(b.callId);
      if (!call) continue;

      if (call.name === "todo") {
        const i = obj<{ op?: string; items?: { text?: string }[]; index?: number; status?: TodoItem["status"] }>(call.input);
        if (call.ok === false) continue;
        if (i.op === "set" && Array.isArray(i.items)) {
          flushRows();
          plan = { items: i.items.map((it) => ({ text: it.text ?? "", status: "pending" as const })) };
          push({ k: "plan", key: `plan:${call.id}`, items: plan.items });
        } else if (i.op === "update" && plan && typeof i.index === "number" && plan.items[i.index] && i.status) {
          // `active` is exclusive (db/todos.ts): moving one item to active clears the previous one.
          if (i.status === "active") for (const it of plan.items) if (it.status === "active") it.status = "pending";
          plan.items[i.index]!.status = i.status;
        }
        continue;
      }
      if (call.name === "clarify") {
        flushRows();
        const raw = obj<{ questions?: unknown[] }>(call.input).questions;
        const questions = (Array.isArray(raw) ? raw : []).flatMap((q) => {
          const o = obj<ClarifyQuestion>(q);
          return typeof o.question === "string" ? [{ question: o.question, ...(o.default ? { default: o.default } : {}) }] : [];
        });
        push({ k: "clarify", key: `clarify:${call.id}`, questions });
        continue;
      }
      if (call === asked && pendingPermission) {
        flushRows();
        push({ k: "ask", key: `ask:${pendingPermission.reqId}`, request: pendingPermission });
        continue;
      }
      if (call.ok !== false && MUTATING.has(call.name)) mutated = true;
      noteChange(files, call);
      run.push(call);
    }
    flushRows();

    const list = [...files.values()];
    if (list.length && !pending && !blocks.some((x) => x.k === "ask")) {
      push({
        k: "changes",
        key: `changes:${key0}`,
        files: list,
        added: list.reduce((s, f) => s + f.added, 0),
        removed: list.reduce((s, f) => s + f.removed, 0),
        undoable: false,
      });
    }
    const from = msgs.find((m) => m.model) ?? null;
    return {
      k: "ai",
      key: key0,
      blocks,
      pending,
      waiting: blocks.some((x) => x.k === "ask"),
      mutated,
      answers: userCount > 0 ? userCount - 1 : undefined,
      provider: from?.providerId,
      model: from?.model,
    };
  }

  for (const m of messages) {
    if (m.role === "assistant") {
      group.push(m);
      continue;
    }
    flushAi();
    if (m.role === "user") {
      turns.push({ k: "user", key: m.id, text: m.content ?? "", message: m });
      userCount++;
    } else turns.push({ k: "note", key: m.id, id: m.id, text: m.content ?? "" });
  }
  flushAi();

  // A pending ask whose call never showed up in a message: give it a turn of its own at the end.
  if (pendingPermission && !turns.some((t) => t.k === "ai" && t.blocks.some((b) => b.k === "ask"))) {
    const last = turns[turns.length - 1];
    const ask: Block = { k: "ask", key: `ask:${pendingPermission.reqId}`, request: pendingPermission };
    if (last?.k === "ai") {
      last.blocks.push(ask);
      last.waiting = true;
    } else {
      turns.push({ k: "ai", key: `ask-turn:${pendingPermission.reqId}`, blocks: [ask], pending: false, waiting: true, mutated: false, answers: userCount > 0 ? userCount - 1 : undefined });
    }
  }

  // Undo applies to the last run only, so only the last turn's changes card offers it.
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]!;
    if (t.k !== "ai") continue;
    const card = t.blocks.find((b) => b.k === "changes");
    if (card && card.k === "changes" && !turns.slice(i + 1).some((x) => x.k === "user")) card.undoable = true;
    break;
  }
  return turns;
}

/** Which file a call changed, and by how much, for the Changes card. */
function noteChange(files: Map<string, ChangedFile>, c: ToolCallDTO) {
  if (c.ok !== true) return;
  const s = c.resultSummary ?? "";
  const add = (path: string, kind: ChangedFile["kind"], added: number, removed: number) => {
    if (!path) return;
    const prev = files.get(path);
    if (!prev) files.set(path, { path, kind, added, removed });
    else files.set(path, { ...prev, kind: prev.kind === "created" ? "created" : kind, added: prev.added + added, removed: prev.removed + removed });
  };
  if (c.name === "edit" || c.name === "write") {
    const path = obj<{ path?: string }>(c.input).path ?? "";
    const created = s.match(/^created · (\d+) lines?/);
    const delta = s.match(/^\+(\d+) −(\d+)$/);
    if (created) add(path, "created", Number(created[1]), 0);
    else if (delta) add(path, "edited", Number(delta[1]), Number(delta[2]));
    else add(path, "edited", 0, 0);
  } else if (c.name === "file_op") {
    const i = obj<{ op?: string; from?: string; to?: string; path?: string }>(c.input);
    if (i.op === "remove") add(i.path ?? "", "deleted", 0, 0);
    else if ((i.op === "move" || i.op === "copy") && i.to) add(i.to, "created", 0, 0);
  }
}
