// engine/src/agent/run/transcript.test.ts
import { describe, expect, test } from "bun:test";
import {
  assertNoOrphanToolMessages,
  clearStepInjected,
  findOrphanToolMessage,
  formatSummary,
  project,
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

  test("places tag: 'todo' injected entry immediately after the last user message", () => {
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

    // Todo reminder must be spliced right after u2 (index 2 + 1 = 3), before a2
    expect(wire).toHaveLength(5);
    expect(wire[0].role).toBe("user");
    expect(wire[1].role).toBe("assistant");
    expect(wire[2].role).toBe("user");
    expect(wire[2].content).toBe("Second turn");
    expect(wire[3].role).toBe("user");
    expect(wire[3].content).toContain("todo-list");
    expect(wire[4].role).toBe("assistant");
    expect(wire[4].content).toBe("Working on 2");
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
