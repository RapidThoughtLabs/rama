// engine/src/agent/run/compact.test.ts
//
// Tests for Phase LM5: Compaction & Decay (C7/C8/L4)
// docs/LOOP_MIGRATION_PLAN.md LM5

import { describe, expect, test } from "bun:test";
import { compactTranscript, computeSafeCutIndex, decayTranscript } from "./compact";
import { assertNoOrphanToolMessages, findOrphanToolMessage, project, type Transcript, type TranscriptEntry } from "./transcript";

describe("LM5 Compaction and Decay", () => {
  test("C7 decay: drops superseded read results when same file is read later", () => {
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Please inspect src/index.ts" },
        {
          kind: "assistant",
          id: "a1",
          text: "Reading file...",
          calls: [{ id: "call_read_1", name: "read", input: { path: "src/index.ts" } }],
        },
        {
          kind: "tool",
          callId: "call_read_1",
          name: "read",
          ok: true,
          content: "export const version = '1.0.0'; // initial read",
        },
        {
          kind: "assistant",
          id: "a2",
          text: "Reading updated file...",
          calls: [{ id: "call_read_2", name: "read", input: { path: "src/index.ts" } }],
        },
        {
          kind: "tool",
          callId: "call_read_2",
          name: "read",
          ok: true,
          content: "export const version = '2.0.0'; // second read",
        },
      ],
      ephemeral: {},
    };

    const { decayedCount, approxTokensSaved } = decayTranscript(transcript);
    expect(decayedCount).toBe(1);
    expect(approxTokensSaved).toBeGreaterThanOrEqual(0);

    const firstTool = transcript.entries[2];
    expect(firstTool.kind).toBe("tool");
    if (firstTool.kind === "tool") {
      expect(firstTool.content).toBe("[Superseded by later read of src/index.ts]");
    }

    const secondTool = transcript.entries[4];
    expect(secondTool.kind).toBe("tool");
    if (secondTool.kind === "tool") {
      expect(secondTool.content).toBe("export const version = '2.0.0'; // second read");
    }
  });

  test("C7 decay: truncates large tool output from older turns", () => {
    const hugeOutput = "x".repeat(2500);
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Run big command" },
        {
          kind: "assistant",
          id: "a1",
          text: "",
          calls: [{ id: "c1", name: "bash", input: {} }],
        },
        {
          kind: "tool",
          callId: "c1",
          name: "bash",
          ok: true,
          content: hugeOutput,
        },
        { kind: "user", id: "u2", text: "Next turn" },
        { kind: "assistant", id: "a2", text: "Working...", calls: [] },
        { kind: "user", id: "u3", text: "Current turn" },
        { kind: "assistant", id: "a3", text: "Done", calls: [] },
      ],
      ephemeral: {},
    };

    const { decayedCount, approxTokensSaved } = decayTranscript(transcript);
    expect(decayedCount).toBe(1);
    expect(approxTokensSaved).toBeGreaterThan(400); // 2500 - 500 = ~2000 chars / 4 = ~500 tokens

    const toolEntry = transcript.entries[2];
    expect(toolEntry.kind).toBe("tool");
    if (toolEntry.kind === "tool") {
      expect(toolEntry.content.length).toBeLessThan(600);
      expect(toolEntry.content).toContain("[output decayed]");
    }
  });

  test("C8 structured compaction: summarizes older entries into structured summary entry", async () => {
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Create an auth module in src/auth.ts" },
        {
          kind: "assistant",
          id: "a1",
          text: "I will create src/auth.ts with password hashing.",
          calls: [{ id: "c1", name: "write", input: { path: "src/auth.ts" } }],
        },
        {
          kind: "tool",
          callId: "c1",
          name: "write",
          ok: true,
          content: "File written",
        },
        {
          kind: "assistant",
          id: "a2",
          text: "I wrote the auth module.",
          calls: [],
        },
        { kind: "user", id: "u2", text: "Now add tests for auth" },
        { kind: "assistant", id: "a3", text: "Adding tests...", calls: [] },
      ],
      ephemeral: {},
    };

    const mockProviderRow = {
      id: "mock",
      kind: "openai-compatible" as const,
      base_url: "http://localhost:11434/v1",
      label: "Mock",
      created_at: 0,
      models_hash: null,
      models_fetched_at: null,
      last_health_status: null,
      last_health_at: null,
      is_custom: 0,
      enabled: 1,
      requires_key: 0,
      auth_style: "bearer" as const,
      auth_header: null,
      extra_headers_json: "{}",
    };

    const result = await compactTranscript({
      chatId: "chat-compact-1",
      transcript,
      providerRow: mockProviderRow,
      model: "mock-model",
      signal: new AbortController().signal,
      unverifiedWrites: new Set(["src/auth.ts"]),
    });

    expect(result.summary).toBeDefined();
    // The first entry in transcript should now be a summary entry
    const firstEntry = transcript.entries[0];
    expect(firstEntry.kind).toBe("summary");
    if (firstEntry.kind === "summary") {
      expect(firstEntry.fields.summary).toBeDefined();
      expect(firstEntry.covers.length).toBeGreaterThan(0);
    }

    // The active turn (last 2 entries: u2, a3) is preserved intact
    const lastUser = transcript.entries.find((e) => e.kind === "user" && e.text === "Now add tests for auth");
    expect(lastUser).toBeDefined();

    // Pure projection renders the summary cleanly
    const wire = project(transcript, {
      cacheStyle: "explicit",
      supportsMidConversationSystem: true,
    });
    const summaryWire = wire.find((m) => typeof m.content === "string" && m.content.includes("system-summary"));
    expect(summaryWire).toBeDefined();
  });
});

// docs/LOOP_MENDING_PLAN.md D2/MD2 — the naive cut ("entries.length - 2") can land between an
// assistant's tool_calls and its tool results, orphaning a `tool` entry in the preserved tail.
// The invariant (assertNoOrphanToolMessages) is the actual safeguard; computeSafeCutIndex is
// only trusted because it holds over every cut it can produce.
describe("computeSafeCutIndex (D2)", () => {
  function summaryEntryFor(covered: TranscriptEntry[]): TranscriptEntry {
    return { kind: "summary", id: "s1", covers: [], fields: { summary: `covers ${covered.length} entries` } };
  }

  test("reproduces the exact bug: a naive cut of length-2 lands mid tool-result run", () => {
    // 5 entries: user, assistant(2 calls), tool, tool. Naive cut = 5-2 = 3, which is entries[3]
    // ("tool") — exactly the demonstrated bug ("summary, tool, tool" with the middle tool
    // orphaned).
    const entries: TranscriptEntry[] = [
      { kind: "user", id: "u1", text: "do two things" },
      {
        kind: "assistant",
        id: "a1",
        text: "",
        calls: [
          { id: "c1", name: "read", input: {} },
          { id: "c2", name: "read", input: {} },
        ],
      },
      { kind: "tool", callId: "c1", name: "read", ok: true, content: "one" },
      { kind: "tool", callId: "c2", name: "read", ok: true, content: "two" },
    ];
    expect(Math.max(1, entries.length - 2)).toBe(2); // naive cut lands on entries[2], a "tool" entry
    expect(entries[2].kind).toBe("tool");

    const safeCut = computeSafeCutIndex(entries);
    // The safe cut must not land on a "tool" entry — it has to back up to the owning assistant.
    expect(entries[safeCut]?.kind).not.toBe("tool");

    const tail = entries.slice(safeCut);
    const wire = project({ entries: [summaryEntryFor(entries.slice(0, safeCut)), ...tail], ephemeral: {} }, { cacheStyle: "none", supportsMidConversationSystem: true });
    expect(findOrphanToolMessage(wire)).toBeNull();
  });

  test("property: over 300 randomised transcripts, the safe cut never orphans a tool message", () => {
    function randomTranscript(seed: number): TranscriptEntry[] {
      let s = seed;
      const rand = () => {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
      const entries: TranscriptEntry[] = [];
      const turns = 1 + Math.floor(rand() * 6);
      let callCounter = 0;
      for (let t = 0; t < turns; t++) {
        entries.push({ kind: "user", id: `u${t}`, text: `turn ${t}` });
        const assistantSteps = 1 + Math.floor(rand() * 3);
        for (let a = 0; a < assistantSteps; a++) {
          const numCalls = Math.floor(rand() * 3); // 0, 1, or 2 tool calls
          const calls = Array.from({ length: numCalls }, () => ({ id: `c${callCounter++}`, name: "read", input: {} }));
          entries.push({ kind: "assistant", id: `a${t}-${a}`, text: numCalls === 0 ? "done" : "", calls });
          for (const call of calls) {
            entries.push({ kind: "tool", callId: call.id, name: "read", ok: true, content: "result" });
          }
        }
      }
      return entries;
    }

    for (let seed = 1; seed <= 300; seed++) {
      const entries = randomTranscript(seed);
      if (entries.length < 3) continue;
      const safeCut = computeSafeCutIndex(entries);
      if (safeCut < 1) continue; // nothing safe to cut — not this function's failure mode

      const covered = entries.slice(0, safeCut);
      const tail = entries.slice(safeCut);
      const spliced: TranscriptEntry[] = [summaryEntryFor(covered), ...tail];
      const wire = project({ entries: spliced, ephemeral: {} }, { cacheStyle: "none", supportsMidConversationSystem: true });

      expect(() => assertNoOrphanToolMessages(wire)).not.toThrow();
    }
  });
});
