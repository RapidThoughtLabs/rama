import { describe, expect, test } from "bun:test";
import type { ChatBlock, MessageDTO, ToolCallDTO } from "@rama/protocol";
import { buildTranscript, type Block, type BuildInput } from "./buildTranscript";
import { labelText } from "./rows";

let seq = 0;
const user = (text: string): MessageDTO => ({ id: `u${++seq}`, chatId: "c", seq, role: "user", content: text, thinking: null, createdAt: 0 });
const ai = (id: string, blocks: ChatBlock[], extra: Partial<MessageDTO> = {}): MessageDTO => ({ id, chatId: "c", seq: ++seq, role: "assistant", content: null, thinking: null, createdAt: 0, blocks, ...extra });
const call = (id: string, messageId: string, name: string, input: unknown, summary: string | null = "", ok: boolean | null = true): ToolCallDTO => ({
  id, messageId, chatId: "c", name, input, ok, resultSummary: ok === null ? null : summary, startedAt: 0, endedAt: 0, artifactId: null,
});
const tool = (callId: string): ChatBlock => ({ kind: "tool", callId });
const text = (t: string): ChatBlock => ({ kind: "text", text: t });

const build = (over: Partial<BuildInput>) => buildTranscript({ messages: [], toolCalls: [], artifacts: [], pendingPermission: null, ...over });
const kinds = (blocks: Block[]) => blocks.map((b) => b.k);
const aiTurn = (turns: ReturnType<typeof build>, n = 0) => turns.filter((t) => t.k === "ai")[n] as Extract<ReturnType<typeof build>[number], { k: "ai" }>;

describe("turn structure", () => {
  test("user, ai, note", () => {
    const turns = build({ messages: [user("hi"), ai("a1", [text("hello")]), { ...user("x"), role: "system", content: "Compacted." }] });
    expect(turns.map((t) => t.k)).toEqual(["user", "ai", "note"]);
  });
  test("every assistant row between two user messages is one turn", () => {
    const turns = build({ messages: [user("go"), ai("a1", [text("one")]), ai("a2", [text("two")])] });
    expect(turns).toHaveLength(2);
    expect(aiTurn(turns).blocks).toEqual([{ k: "prose", key: expect.any(String), markdown: "one\n\ntwo" }]);
  });
  test("an AI turn knows which user message it answers", () => {
    const turns = build({ messages: [user("a"), ai("a1", [text("x")]), user("b"), ai("a2", [text("y")])] });
    expect(aiTurn(turns, 0).answers).toBe(0);
    expect(aiTurn(turns, 1).answers).toBe(1);
  });
  test("a message from before blocks were stored: thinking, tools, then text", () => {
    const turns = build({
      messages: [user("x"), ai("a1", [], { blocks: undefined, thinking: "hm", thinkingDurationMs: 2000, content: "done" })],
      toolCalls: [call("c1", "a1", "read", { path: "a.ts" }, "1-2 of 2 lines")],
    });
    expect(kinds(aiTurn(turns).blocks)).toEqual(["row", "row", "prose"]);
  });
});

describe("rows and prose", () => {
  test("thinking joins the explore rows after it; prose splits the groups", () => {
    const turns = build({
      messages: [
        user("fix"),
        ai("a1", [{ kind: "thinking", text: "look first", durationMs: 4000 }, tool("c1"), tool("c2"), text("It's a timing problem."), tool("c3")]),
      ],
      toolCalls: [call("c1", "a1", "read", { path: "a.ts" }, "1-9 of 9 lines"), call("c2", "a1", "grep", { pattern: "x" }, "3 matches across 2 files"), call("c3", "a1", "edit", { path: "a.ts" }, "+1 −1")],
    });
    const blocks = aiTurn(turns).blocks;
    expect(kinds(blocks)).toEqual(["row", "row", "prose", "row", "changes"]);
    const labels = blocks.flatMap((b) => (b.k === "row" ? [labelText(b.row.label)] : []));
    expect(labels).toEqual(["Thought for 4 seconds", "Looked through 1 file", "Edited a.ts"]);
  });
  test("empty text blocks and empty finished thinking draw nothing", () => {
    const turns = build({ messages: [user("x"), ai("a1", [text("  "), { kind: "thinking", text: "" }, text("ok")])] });
    expect(kinds(aiTurn(turns).blocks)).toEqual(["prose"]);
  });
  test("a streaming thinking block is a live row", () => {
    const turns = build({ messages: [user("x"), ai("pending-1", [{ kind: "thinking", text: "hm", stepIndex: 0, blockIndex: 0 }])], liveElapsed: () => 3200 });
    const t = aiTurn(turns);
    expect(t.pending).toBe(true);
    const row = t.blocks[0]!;
    expect(row.k === "row" && row.row.live && row.row.meta[0]!.text).toBe("3 seconds");
  });
  test("a call whose message has no matching tool call is skipped", () => {
    expect(kinds(aiTurn(build({ messages: [user("x"), ai("a1", [tool("ghost"), text("ok")])] })).blocks)).toEqual(["prose"]);
  });
});

describe("plan", () => {
  const calls = [
    call("t1", "a1", "todo", { op: "set", items: [{ text: "one" }, { text: "two" }, { text: "three" }] }, "0/3 done"),
    call("e1", "a1", "edit", { path: "a.ts" }, "+1 −0"),
    call("t2", "a1", "todo", { op: "update", index: 0, status: "done" }, "1/3 done"),
    call("t3", "a1", "todo", { op: "update", index: 1, status: "active" }, "1/3 done"),
  ];
  const messages = [user("go"), ai("a1", [tool("t1"), tool("e1"), tool("t2"), tool("t3")])];
  test("one card at the first todo call, folded from set and updates; todo draws no row", () => {
    const blocks = aiTurn(build({ messages, toolCalls: calls })).blocks;
    expect(kinds(blocks)).toEqual(["plan", "row", "changes"]);
    const plan = blocks[0]!;
    expect(plan.k === "plan" && plan.items.map((i) => i.status)).toEqual(["done", "active", "pending"]);
  });
  test("moving another item to active clears the previous one", () => {
    const more = [...calls, call("t4", "a1", "todo", { op: "update", index: 2, status: "active" })];
    const m = [user("go"), ai("a1", [...messages[1]!.blocks!, tool("t4")])];
    const plan = aiTurn(build({ messages: m, toolCalls: more })).blocks[0]!;
    expect(plan.k === "plan" && plan.items.map((i) => i.status)).toEqual(["done", "pending", "active"]);
  });
  test("a second set starts a second card", () => {
    const again = [...calls, call("t5", "a1", "todo", { op: "set", items: [{ text: "x" }] })];
    const m = [user("go"), ai("a1", [...messages[1]!.blocks!, tool("t5")])];
    expect(kinds(aiTurn(build({ messages: m, toolCalls: again })).blocks).filter((k) => k === "plan")).toHaveLength(2);
  });
});

describe("changes card", () => {
  const msgs = [user("do it"), ai("a1", [tool("e1"), tool("e2"), tool("w1"), tool("r1")])];
  const calls = [
    call("e1", "a1", "edit", { path: "a.ts" }, "+4 −2"),
    call("e2", "a1", "edit", { path: "a.ts" }, "+1 −0"),
    call("w1", "a1", "write", { path: "b.test.ts" }, "created · 31 lines"),
    call("r1", "a1", "file_op", { op: "remove", path: "old.ts" }, "removed"),
  ];
  test("de-duplicates by path, sums the delta, and marks created and deleted", () => {
    const card = aiTurn(build({ messages: msgs, toolCalls: calls })).blocks.at(-1)!;
    expect(card.k).toBe("changes");
    if (card.k !== "changes") return;
    expect(card.files).toEqual([
      { path: "a.ts", kind: "edited", added: 5, removed: 2 },
      { path: "b.test.ts", kind: "created", added: 31, removed: 0 },
      { path: "old.ts", kind: "deleted", added: 0, removed: 0 },
    ]);
    expect([card.added, card.removed]).toEqual([36, 2]);
  });
  test("only the last turn's card can undo, and not once the user has spoken again", () => {
    const two = [...msgs, user("again"), ai("a2", [tool("e3")])];
    const calls2 = [...calls, call("e3", "a2", "edit", { path: "c.ts" }, "+1 −1")];
    const cards = build({ messages: two, toolCalls: calls2 }).flatMap((t) => (t.k === "ai" ? t.blocks.filter((b) => b.k === "changes") : []));
    expect(cards.map((c) => c.k === "changes" && c.undoable)).toEqual([false, true]);
    const spoken = build({ messages: [...msgs, user("thanks")], toolCalls: calls }).flatMap((t) => (t.k === "ai" ? t.blocks.filter((b) => b.k === "changes") : []));
    expect(spoken.map((c) => c.k === "changes" && c.undoable)).toEqual([false]);
  });
  test("a failed edit is not a change, and a streaming turn has no card yet", () => {
    const failed = build({ messages: [user("x"), ai("a1", [tool("e1")])], toolCalls: [call("e1", "a1", "edit", { path: "a.ts" }, "refused", false)] });
    expect(kinds(aiTurn(failed).blocks)).toEqual(["row"]);
    expect(aiTurn(failed).mutated).toBe(false);
    const live = build({ messages: [user("x"), ai("pending-1", [tool("e1")])], toolCalls: [call("e1", "pending-1", "edit", { path: "a.ts" }, "+1 −0")] });
    expect(kinds(aiTurn(live).blocks)).toEqual(["row"]);
  });
  test("mutated is true for a turn that edited", () => {
    expect(aiTurn(build({ messages: msgs, toolCalls: calls })).mutated).toBe(true);
    expect(aiTurn(build({ messages: [user("x"), ai("a1", [tool("c1")])], toolCalls: [call("c1", "a1", "read", { path: "a" }, "1-1 of 1 lines")] })).mutated).toBe(false);
  });
});

describe("permission ask", () => {
  const commit = { op: "commit", message: "Apply the theme", stageAll: true };
  const req = { reqId: "r1", tool: "git_write", input: commit, risk: "high" as const };
  test("replaces the unfinished call's row, and the turn has no actions", () => {
    const turns = build({ messages: [user("commit"), ai("a1", [tool("g1")])], toolCalls: [call("g1", "a1", "git_write", commit, null, null)], pendingPermission: req });
    const t = aiTurn(turns);
    expect(kinds(t.blocks)).toEqual(["ask"]);
    expect(t.waiting).toBe(true);
  });
  test("rows before the ask stay", () => {
    const turns = build({
      messages: [user("x"), ai("a1", [tool("e1"), tool("g1")])],
      toolCalls: [call("e1", "a1", "edit", { path: "a.ts" }, "+1 −0"), call("g1", "a1", "git_write", commit, null, null)],
      pendingPermission: req,
    });
    expect(kinds(aiTurn(turns).blocks)).toEqual(["row", "ask"]);
  });
  test("an ask whose call has not arrived still shows, at the end", () => {
    const turns = build({ messages: [user("x"), ai("a1", [text("Let me commit.")])], pendingPermission: req });
    expect(kinds(aiTurn(turns).blocks)).toEqual(["prose", "ask"]);
    expect(build({ messages: [user("x")], pendingPermission: req }).map((t) => t.k)).toEqual(["user", "ai"]);
  });
});

describe("clarify", () => {
  test("a question card, not a row", () => {
    const turns = build({
      messages: [user("x"), ai("a1", [tool("q1")])],
      toolCalls: [call("q1", "a1", "clarify", { questions: [{ question: "Which theme?", default: "Kanagawa" }, { question: "Cache where?" }, { nope: 1 }] }, "")],
    });
    const b = aiTurn(turns).blocks[0]!;
    expect(b.k === "clarify" && b.questions).toEqual([{ question: "Which theme?", default: "Kanagawa" }, { question: "Cache where?" }]);
  });
});
