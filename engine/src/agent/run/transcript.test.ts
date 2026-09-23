// engine/src/agent/run/transcript.test.ts
import type { MessageDTO } from "@rama/protocol";
import { describe, expect, test } from "bun:test";
import type { CompactionRow } from "../../db/compactions";
import { createToolCall, finalizeToolCall, type ToolCallHistoryEntry } from "../../db/toolCalls";
import { createChat, deleteChat } from "../../db/chats";
import { appendMessage, finalizeMessage } from "../../db/messages";
import { createProject, deleteProject } from "../../db/projects";
import {
  assertNoOrphanToolMessages,
  buildTranscriptFromDb,
  clearStepInjected,
  findOrphanToolMessage,
  formatSummary,
  project,
  projectTranscriptEntries,
  setInjectedEntry,
  type Transcript,
  type TranscriptEntry,
} from "./transcript";
import type { WireMessage } from "../../llm/types";

describe("transcript projection", () => {
  test("projects a basic conversation: user, assistant, tool results", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Read file.txt" },
        {
          kind: "assistant",
          id: "a1",
          text: "I will read that file.",
          calls: [{ id: "call_1", name: "read", input: { path: "file.txt" } }],
        },
        { kind: "tool", callId: "call_1", name: "read", ok: true, content: "hello world" },
        { kind: "assistant", id: "a2", text: "The file says hello world", calls: [] },
      ],
      ephemeral: {},
    };

    const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });

    expect(wire).toHaveLength(4);
    expect(wire[0]).toEqual({ role: "user", content: "Read file.txt" });
    expect(wire[1]).toEqual({
      role: "assistant",
      content: "I will read that file.",
      toolCalls: [{ id: "call_1", name: "read", input: { path: "file.txt" } }],
    });
    expect(wire[2]).toEqual({
      role: "tool",
      toolCallId: "call_1",
      content: "hello world",
    });
    expect(wire[3]).toEqual({
      role: "assistant",
      content: "The file says hello world",
    });
  });

  test("CB5: pins the tag: 'todo' injected entry at a fixed position (end of the durable transcript), not spliced into the middle", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "First turn" },
        { kind: "assistant", id: "a1", text: "Done 1", calls: [] },
        { kind: "user", id: "u2", text: "Second turn" },
        { kind: "assistant", id: "a2", text: "Working on 2", calls: [] },
        {
          kind: "injected",
          id: "todo-1",
          role: "user",
          text: '<system-reminder id="todo-list">1. [x] First\n2. [ ] Second</system-reminder>',
          tag: "todo",
          ttl: "step",
        },
      ],
      ephemeral: {},
    };

    const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });

    // The durable entries render in their own order, untouched; the reminder lands after all of
    // them — never between u2 and a2, regardless of where "the last user message" happens to be.
    expect(wire).toHaveLength(5);
    expect(wire[0].content).toBe("First turn");
    expect(wire[1].content).toBe("Done 1");
    expect(wire[2].content).toBe("Second turn");
    expect(wire[3].content).toBe("Working on 2");
    expect(wire[4].role).toBe("user");
    expect(wire[4].content).toContain("todo-list");
  });

  test("CB5: the todo reminder changing content across steps never shifts any earlier entry's position", () => {
    function withTodo(text: string): Transcript {
      return {
        entries: [
          { kind: "user", id: "u1", text: "First turn" },
          { kind: "assistant", id: "a1", text: "Done 1", calls: [] },
          { kind: "user", id: "u2", text: "Second turn" },
          { kind: "assistant", id: "a2", text: "Working on 2", calls: [] },
          { kind: "injected", id: "todo-1", role: "user", text, tag: "todo", ttl: "step" },
        ],
        ephemeral: {},
      };
    }

    const policy = { cacheStyle: "none" as const, supportsMidConversationSystem: true };
    const step1 = project(withTodo("1. [ ] First\n2. [ ] Second"), policy);
    const step2 = project(withTodo("1. [x] First\n2. [ ] Second"), policy);

    // Only the reminder itself (the last entry) differs — everything before it is byte-identical,
    // which is exactly what a stable, cacheable prefix requires.
    expect(step1.slice(0, 4)).toEqual(step2.slice(0, 4));
    expect(step1[4].content).not.toBe(step2[4].content);
  });

  test("marks the last durable message with cacheBreakpoint when cacheStyle is explicit", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Hello" },
        { kind: "assistant", id: "a1", text: "Hi there", calls: [] },
      ],
      ephemeral: {
        text: '<system-reminder id="ephemeral-env">Date: 2026-09-09</system-reminder>',
      },
    };

    const wire = project(t, { cacheStyle: "explicit", supportsMidConversationSystem: true });

    // Must have: u1, a1 (with cacheBreakpoint), trailing ephemeral (without cacheBreakpoint)
    expect(wire).toHaveLength(3);
    expect(wire[0].annotations?.cacheBreakpoint).toBeUndefined();
    expect(wire[1].annotations?.cacheBreakpoint).toBe(true);
    expect(wire[2].annotations?.cacheBreakpoint).toBeUndefined();
    expect(wire[2].content).toContain("ephemeral-env");
    expect(wire[2].role).toBe("system");
  });

  test("CB5/D5: also marks the previous turn's last durable message as a second cache anchor", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "First turn" },
        { kind: "assistant", id: "a1", text: "Done with turn 1", calls: [] },
        { kind: "user", id: "u2", text: "Second turn, still going" },
        { kind: "assistant", id: "a2", text: "Working on it", calls: [] },
      ],
      ephemeral: {},
    };

    const wire = project(t, { cacheStyle: "explicit", supportsMidConversationSystem: true });

    expect(wire).toHaveLength(4);
    expect(wire[0].annotations?.cacheBreakpoint).toBeUndefined(); // u1
    expect(wire[1].annotations?.cacheBreakpoint).toBe(true); // a1 — previous turn's last message
    expect(wire[2].annotations?.cacheBreakpoint).toBeUndefined(); // u2
    expect(wire[3].annotations?.cacheBreakpoint).toBe(true); // a2 — current last durable message
  });

  test("CB5/D5: the previous-turn anchor stays at the same position across every step of the current turn", () => {
    function afterStep(n: number): Transcript {
      const entries: TranscriptEntry[] = [
        { kind: "user", id: "u1", text: "First turn" },
        { kind: "assistant", id: "a1", text: "Done with turn 1", calls: [] },
        { kind: "user", id: "u2", text: "Second turn" },
      ];
      for (let i = 0; i < n; i++) {
        entries.push({
          kind: "assistant",
          id: `a2-${i}`,
          text: "",
          calls: [{ id: `c${i}`, name: "read", input: {} }],
        });
        entries.push({ kind: "tool", callId: `c${i}`, name: "read", ok: true, content: `result ${i}` });
      }
      return { entries, ephemeral: {} };
    }

    const policy = { cacheStyle: "explicit" as const, supportsMidConversationSystem: true };
    const step1 = project(afterStep(1), policy);
    const step2 = project(afterStep(2), policy);

    // Both requests mark the exact same entry (a1, index 1) as a cache anchor, and its content is
    // byte-identical between the two — that repeated marking of an unchanged prefix is what a
    // cache read requires. Only the moving tail anchor (the true last message) differs.
    expect(step1[1]).toEqual(step2[1]);
    expect(step1[1].annotations?.cacheBreakpoint).toBe(true);
  });

  // docs/LOOP_MENDING_PLAN.md G3/MD5 — supportsMidConversationSystem: false (claude-sonnet-5's
  // real constraint) must fall back to role: "user" at all three sites that ever emit role:
  // "system" mid-conversation: summary, injected, and the trailing ephemeral block. One test per
  // site, so a regression at any single site fails on its own rather than only when all three
  // happen to break together.
  describe("supportsMidConversationSystem: false fallback (G3)", () => {
    test("summary entries fall back to user role", () => {
      const t: Transcript = {
        entries: [
          { kind: "user", id: "u1", text: "Hello" },
          { kind: "summary", id: "s1", covers: ["u0"], fields: { summary: "Earlier work." } },
        ],
        ephemeral: {},
      };

      const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: false });
      expect(wire[1].role).toBe("user");
      expect(wire[1].content).toContain("Earlier work.");

      const wireWithSystem = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });
      expect(wireWithSystem[1].role).toBe("system");
    });

    test("injected system-role entries fall back to user role", () => {
      const t: Transcript = {
        entries: [
          { kind: "user", id: "u1", text: "Hello" },
          {
            kind: "injected",
            id: "inj-1",
            role: "system",
            text: "System guidance",
            tag: "guidance",
            ttl: "run",
          },
        ],
        ephemeral: {},
      };

      const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: false });
      expect(wire[1].role).toBe("user");
      expect(wire[1].content).toBe("System guidance");

      const wireWithSystem = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });
      expect(wireWithSystem[1].role).toBe("system");
    });

    test("the trailing ephemeral block falls back to user role", () => {
      const t: Transcript = {
        entries: [{ kind: "user", id: "u1", text: "Hello" }],
        ephemeral: { text: "Ephemeral text" },
      };

      const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: false });
      expect(wire[1].role).toBe("user");
      expect(wire[1].content).toBe("Ephemeral text");

      const wireWithSystem = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });
      expect(wireWithSystem[1].role).toBe("system");
    });
  });

  test("setInjectedEntry replaces existing entry with same tag", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Hi" },
        { kind: "injected", id: "t1", role: "user", text: "old todo", tag: "todo", ttl: "step" },
      ],
      ephemeral: {},
    };

    setInjectedEntry(t, {
      kind: "injected",
      id: "t2",
      role: "user",
      text: "new todo",
      tag: "todo",
      ttl: "step",
    });

    expect(t.entries).toHaveLength(2);
    expect((t.entries[1] as Extract<TranscriptEntry, { kind: "injected" }>).text).toBe("new todo");
  });

  test("clearStepInjected removes ttl: 'step' entries and keeps ttl: 'run'", () => {
    const t: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Hi" },
        { kind: "injected", id: "t1", role: "user", text: "todo", tag: "todo", ttl: "step" },
        { kind: "injected", id: "s1", role: "system", text: "steer", tag: "steer", ttl: "run" },
      ],
      ephemeral: {},
    };

    clearStepInjected(t);

    expect(t.entries).toHaveLength(2);
    expect(t.entries.map((e) => (e as { id: string }).id)).toEqual(["u1", "s1"]);
  });

  test("MD0: leading system blocks project first, in order, before any transcript entry", () => {
    const system: WireMessage[] = [
      { role: "system", content: "kernel+tools", annotations: { cacheBreakpoint: true } },
      { role: "system", content: "agent+mode" },
      { role: "system", content: "project+env" },
    ];
    const t: Transcript = {
      entries: [{ kind: "user", id: "u1", text: "hi" }],
      ephemeral: {},
    };
    const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: true, system });
    expect(wire.slice(0, 3)).toEqual(system);
    expect(wire[3]).toEqual({ role: "user", content: "hi" });
  });

  test("MD0: no system option is a pure no-op — existing callers without it are unaffected", () => {
    const t: Transcript = { entries: [{ kind: "user", id: "u1", text: "hi" }], ephemeral: {} };
    const wire = project(t, { cacheStyle: "none", supportsMidConversationSystem: true });
    expect(wire).toEqual([{ role: "user", content: "hi" }]);
  });

  test("D2/MD2: findOrphanToolMessage / assertNoOrphanToolMessages", () => {
    const paired: WireMessage[] = [
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read", input: {} }] },
      { role: "tool", toolCallId: "c1", content: "ok" },
    ];
    expect(findOrphanToolMessage(paired)).toBeNull();
    expect(() => assertNoOrphanToolMessages(paired)).not.toThrow();

    const orphan: WireMessage[] = [{ role: "tool", toolCallId: "c1", content: "ok" }];
    expect(findOrphanToolMessage(orphan)).toEqual(orphan[0]);
    expect(() => assertNoOrphanToolMessages(orphan)).toThrow();
  });

  test("formatSummary formats structured compaction fields cleanly", () => {
    const text = formatSummary({
      summary: "Refactored user auth",
      filesModified: ["src/auth.ts", "src/login.ts"],
      keyDecisions: ["Use JWT instead of sessions"],
      openQuestions: ["Should refresh tokens be rotated?"],
    });

    expect(text).toContain("Summary: Refactored user auth");
    expect(text).toContain("Files modified: src/auth.ts, src/login.ts");
    expect(text).toContain("Key decisions:\n- Use JWT instead of sessions");
    expect(text).toContain("Open questions:\n- Should refresh tokens be rotated?");
  });
});

// docs/CONTEXT_BUDGET_PLAN.md CB2 — buildTranscriptFromDb becomes the projection seam: a decayed
// tool row projects as a placeholder, and rows covered by a compaction boundary project as its
// summary entry. Tested here against projectTranscriptEntries (the pure core buildTranscriptFromDb
// wraps) rather than the DB-backed function itself, so the acceptance property — the projection is
// determined entirely by persisted rows, not by any in-memory state — is provable without a
// database: two independently-built fixture sets standing in for "before" and "after a restart".
describe("CB2: buildTranscriptFromDb's projection seam", () => {
  function msg(over: Partial<MessageDTO> & Pick<MessageDTO, "id" | "seq" | "role">): MessageDTO {
    return { chatId: "chat1", content: null, thinking: null, createdAt: 0, ...over };
  }

  test("a decayed tool call projects a placeholder, stays paired with its assistant message (no orphan)", () => {
    const messages: MessageDTO[] = [
      msg({ id: "u1", seq: 1, role: "user", content: "Read file.txt" }),
      msg({ id: "a1", seq: 2, role: "assistant", content: "Reading it now." }),
    ];
    const call: ToolCallHistoryEntry = {
      id: "call_1",
      messageId: "a1",
      name: "read",
      input: { path: "file.txt" },
      ok: true,
      resultContent: "the actual file contents, verbatim",
      resultSummary: "read 1 file",
      decayedAt: 1_700_000_000_000,
    };
    const callsByMessage = new Map([["a1", [call]]]);

    const entries = projectTranscriptEntries(messages, callsByMessage, null);
    const wire = project({ entries, ephemeral: {} }, { cacheStyle: "none", supportsMidConversationSystem: true });

    expect(() => assertNoOrphanToolMessages(wire)).not.toThrow();
    const toolMsg = wire.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).not.toContain("the actual file contents");
    expect(toolMsg!.content).toContain("Decayed");
    // D1 — the real content is never touched by decay, only what projects to the model.
    expect(call.resultContent).toBe("the actual file contents, verbatim");
  });

  test("messages covered by a compaction boundary collapse into one summary entry; later entries replay normally", () => {
    const messages: MessageDTO[] = [
      msg({ id: "u1", seq: 1, role: "user", content: "First turn" }),
      msg({ id: "a1", seq: 2, role: "assistant", content: "Done with turn 1" }),
      msg({ id: "u2", seq: 3, role: "user", content: "Second turn" }),
      msg({ id: "a2", seq: 4, role: "assistant", content: "Working on turn 2" }),
    ];
    const call: ToolCallHistoryEntry = {
      id: "call_1",
      messageId: "a1",
      name: "bash",
      input: { command: "echo hi" },
      ok: true,
      resultContent: "hi",
      resultSummary: "ran command",
      decayedAt: null,
    };
    const callsByMessage = new Map([["a1", [call]]]);
    const compaction: CompactionRow = {
      id: "compaction_1",
      chatId: "chat1",
      boundarySeq: 2,
      fields: { summary: "User asked about turn 1; agent ran echo hi and finished." },
      coveredIds: ["u1", "a1", "call_1"],
      createdAt: 1_700_000_000_000,
    };

    const entries = projectTranscriptEntries(messages, callsByMessage, compaction);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      kind: "summary",
      id: "compaction_1",
      covers: ["u1", "a1", "call_1"],
      fields: compaction.fields,
    });
    expect(entries[1]).toEqual({ kind: "user", id: "u2", text: "Second turn" });
    expect(entries[2]).toMatchObject({ kind: "assistant", id: "a2", text: "Working on turn 2" });

    const wire = project({ entries, ephemeral: {} }, { cacheStyle: "none", supportsMidConversationSystem: true });
    expect(() => assertNoOrphanToolMessages(wire)).not.toThrow();
    // The covered tool call never reaches the wire at all — it's inside the summary, not replayed.
    expect(wire.some((m) => m.role === "tool")).toBe(false);
  });

  test("restart round-trip: two independently-built fixture sets for the same persisted state project identically", () => {
    // Two structurally-identical but reference-distinct fixture sets, standing in for "the state
    // right after decay+compaction ran" and "the same chat reloaded after a restart" — proving
    // the projection is a pure function of persisted rows, not of any run-scoped object identity.
    const buildFixtures = (): [MessageDTO[], Map<string, ToolCallHistoryEntry[]>, CompactionRow] => {
      const messages: MessageDTO[] = [
        msg({ id: "u1", seq: 1, role: "user", content: "Investigate the flaky test" }),
        msg({ id: "a1", seq: 2, role: "assistant", content: "Looking into it." }),
        msg({ id: "u2", seq: 3, role: "user", content: "Any luck?" }),
        msg({ id: "a2", seq: 4, role: "assistant", content: "Found it, fixing now." }),
      ];
      const call: ToolCallHistoryEntry = {
        id: "call_1",
        messageId: "a2",
        name: "grep",
        input: { pattern: "flaky" },
        ok: true,
        resultContent: "3 matches",
        resultSummary: "grep ran",
        decayedAt: 1_700_000_000_000,
      };
      const compaction: CompactionRow = {
        id: "compaction_1",
        chatId: "chat1",
        boundarySeq: 1,
        fields: { summary: "User asked to investigate a flaky test." },
        coveredIds: ["u1"],
        createdAt: 1_700_000_000_000,
      };
      return [messages, new Map([["a2", [call]]]), compaction];
    };

    const [messagesA, callsA, compactionA] = buildFixtures();
    const [messagesB, callsB, compactionB] = buildFixtures();
    expect(messagesA).not.toBe(messagesB); // genuinely independent object graphs

    const entriesA = projectTranscriptEntries(messagesA, callsA, compactionA);
    const entriesB = projectTranscriptEntries(messagesB, callsB, compactionB);
    expect(entriesA).toEqual(entriesB);

    const policy = { cacheStyle: "none" as const, supportsMidConversationSystem: true };
    const wireA = project({ entries: entriesA, ephemeral: {} }, policy);
    const wireB = project({ entries: entriesB, ephemeral: {} }, policy);
    expect(wireA).toEqual(wireB);
    expect(() => assertNoOrphanToolMessages(wireA)).not.toThrow();
    expect(() => assertNoOrphanToolMessages(wireB)).not.toThrow();
  });
});

// docs/CONTEXT_BUDGET_PLAN.md CB6 — "one assistant row per step". run.ts/step.ts persist one
// DB row per step (appendMessage before executeStep, finalizeMessage right after, both live in
// run.ts's step loop — see the CB6 comments there); this is the property test the plan's
// acceptance criterion asks for: a fresh N-step turn, rebuilt from the DB, projects
// byte-identical to what a live run's own in-memory Transcript would have sent on that turn's
// final step. Exercised against the real DB (this codebase's only DB — see db/index.ts),
// cleaned up in `finally`.
describe("CB6: one assistant row per step", () => {
  test("buildTranscriptFromDb reproduces exactly what a live 3-step turn would have sent", () => {
    const proj = createProject({ name: "transcript-cb6-test", path: "/tmp/transcript-cb6-test" });
    const chat = createChat(proj.id, {});
    try {
      const u1 = appendMessage(chat.id, { role: "user", content: "read a.ts, then edit it" });

      // Step 1: assistant calls "read" — no closing text, matching what step.ts persists for a
      // step that ends on a tool call (content stays null; blocks record the tool card).
      const step1 = appendMessage(chat.id, { role: "assistant", content: null });
      createToolCall({
        id: "call-1",
        messageId: step1.id,
        chatId: chat.id,
        name: "read",
        input: { path: "a.ts" },
        startedAt: 1,
      });
      finalizeToolCall("call-1", { ok: true, resultSummary: "read a.ts", resultContent: "file contents", endedAt: 2 });
      finalizeMessage(step1.id, null, null, undefined, [{ kind: "tool", callId: "call-1", stepIndex: 0, blockIndex: 0 }]);

      // Step 2: assistant calls "edit" — its own row, its own ascending seq, its own tool call.
      const step2 = appendMessage(chat.id, { role: "assistant", content: null });
      createToolCall({
        id: "call-2",
        messageId: step2.id,
        chatId: chat.id,
        name: "edit",
        input: { path: "a.ts" },
        startedAt: 3,
      });
      finalizeToolCall("call-2", { ok: true, resultSummary: "edited a.ts", resultContent: "ok", endedAt: 4 });
      finalizeMessage(step2.id, null, null, undefined, [{ kind: "tool", callId: "call-2", stepIndex: 1, blockIndex: 0 }]);

      // Step 3: assistant finishes with text and no tool calls — the turn's final step.
      const step3 = appendMessage(chat.id, { role: "assistant", content: null });
      finalizeMessage(step3.id, "Done — edited a.ts.", null, undefined, [
        { kind: "text", text: "Done — edited a.ts.", stepIndex: 2, blockIndex: 0 },
      ]);

      // What a live run's in-memory Transcript looks like by the final step — one entry per step,
      // exactly what step.ts pushes to ctx.transcript.entries as each step executes.
      const liveTranscript: Transcript = {
        entries: [
          { kind: "user", id: u1.id, text: u1.content ?? "" },
          { kind: "assistant", id: step1.id, text: "", calls: [{ id: "call-1", name: "read", input: { path: "a.ts" } }] },
          { kind: "tool", callId: "call-1", name: "read", ok: true, content: "file contents", summary: "read a.ts" },
          { kind: "assistant", id: step2.id, text: "", calls: [{ id: "call-2", name: "edit", input: { path: "a.ts" } }] },
          { kind: "tool", callId: "call-2", name: "edit", ok: true, content: "ok", summary: "edited a.ts" },
          { kind: "assistant", id: step3.id, text: "Done — edited a.ts.", calls: [] },
        ],
        ephemeral: {},
      };

      const policy = { cacheStyle: "none" as const, supportsMidConversationSystem: true };
      const expectedWire = project(liveTranscript, policy);

      const reloaded = buildTranscriptFromDb(chat.id);
      const actualWire = project(reloaded, policy);

      expect(actualWire).toEqual(expectedWire);
      expect(() => assertNoOrphanToolMessages(actualWire)).not.toThrow();
      // Not collapsed into one row: three separate assistant entries survive the reload, each
      // with its own step's calls — the thing CB6 actually changes.
      expect(reloaded.entries.filter((e) => e.kind === "assistant")).toHaveLength(3);
    } finally {
      deleteChat(chat.id);
      deleteProject(proj.id);
    }
  });

  test("an interrupted step's tool calls survive the reload even though its content stayed null", () => {
    // D11/MD3's orphan-finalization case, now exercised through CB6's per-step rows: a step whose
    // row never got real content (the run was interrupted mid-tool-execution) still has to
    // project an assistant entry declaring its tool call — otherwise the finalized "failed" tool
    // result becomes an orphan wire message with no preceding tool_calls entry to pair with.
    const proj = createProject({ name: "transcript-cb6-orphan-test", path: "/tmp/transcript-cb6-orphan-test" });
    const chat = createChat(proj.id, {});
    try {
      appendMessage(chat.id, { role: "user", content: "run the build" });
      const step = appendMessage(chat.id, { role: "assistant", content: null });
      createToolCall({ id: "call-x", messageId: step.id, chatId: chat.id, name: "bash", input: { cmd: "build" }, startedAt: 1 });
      // Simulates run.ts's finally-block finalizeOrphanedToolCalls: the run ended before this
      // tool call's real result ever came back, so it's finalized with ok: false and a cause.
      finalizeToolCall("call-x", { ok: false, resultSummary: "run ended (interrupted-by-user) before this tool call finished", endedAt: 2 });
      // finalizeMessage was never called for `step` — content stays null, exactly as an
      // interrupted step's row is left by run.ts.

      const reloaded = buildTranscriptFromDb(chat.id);
      const wire = project(reloaded, { cacheStyle: "none", supportsMidConversationSystem: true });

      expect(() => assertNoOrphanToolMessages(wire)).not.toThrow();
      const assistantEntries = reloaded.entries.filter((e) => e.kind === "assistant");
      expect(assistantEntries).toHaveLength(1);
      if (assistantEntries[0].kind === "assistant") {
        expect(assistantEntries[0].calls.map((c) => c.id)).toEqual(["call-x"]);
      }
    } finally {
      deleteChat(chat.id);
      deleteProject(proj.id);
    }
  });
});
