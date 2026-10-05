// engine/src/agent/run/compact.test.ts
//
// Tests for Phase LM5: Compaction & Decay (C7/C8/L4)
// docs/LOOP_MIGRATION_PLAN.md LM5

import { describe, expect, test } from "bun:test";
import { compactTranscript, computeSafeCutIndex, decayTranscript } from "./compact";
import {
  assertNoOrphanToolMessages,
  buildTranscriptFromDb,
  findOrphanToolMessage,
  project,
  type Transcript,
  type TranscriptEntry,
} from "./transcript";
import { getLatestCompaction } from "../../db/compactions";
import { createChat, deleteChat } from "../../db/chats";
import { appendMessage } from "../../db/messages";
import { createProject, deleteProject } from "../../db/projects";

const UNREACHABLE_PROVIDER_ROW = {
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
      expect(firstTool.content).toBe("[Superseded by a later read of src/index.ts]");
    }

    const secondTool = transcript.entries[4];
    expect(secondTool.kind).toBe("tool");
    if (secondTool.kind === "tool") {
      expect(secondTool.content).toBe("export const version = '2.0.0'; // second read");
    }
  });

  // docs/CONTEXT_BUDGET_PLAN.md CB3 — age/budget eviction replaces the fixed "entriesCount - 4"
  // window with opencode's shape: protect a recent-output token budget and the last two turns
  // outright, and only commit if the whole pass frees more than a floor. A lone small stale
  // entry below the floor is untouched — see the next test.
  test("CB3 decay: evicts old tool output once the pass would free enough to clear the floor, protecting recent turns", () => {
    const oldOutput = "x".repeat(90_000); // the eviction target
    const recentOutput = "y".repeat(200_000); // exceeds the 40k-token protected budget on its own
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Run an old big command" },
        { kind: "assistant", id: "a1", text: "", calls: [{ id: "c1", name: "bash", input: { command: "old" } }] },
        { kind: "tool", callId: "c1", name: "bash", ok: true, content: oldOutput, summary: "ran old command" },
        { kind: "user", id: "u2", text: "Run a recent big command" },
        { kind: "assistant", id: "a2", text: "", calls: [{ id: "c2", name: "bash", input: { command: "recent" } }] },
        { kind: "tool", callId: "c2", name: "bash", ok: true, content: recentOutput, summary: "ran recent command" },
        { kind: "user", id: "u3", text: "Current turn" },
        { kind: "assistant", id: "a3", text: "Done", calls: [] },
      ],
      ephemeral: {},
    };

    const { decayedCount, approxTokensSaved, decayedCallIds } = decayTranscript(transcript, { pruneOldToolOutputs: true });
    expect(decayedCount).toBe(1);
    expect(decayedCallIds).toEqual(["c1"]);
    expect(approxTokensSaved).toBeGreaterThan(20_000);

    const oldTool = transcript.entries[2];
    expect(oldTool.kind).toBe("tool");
    if (oldTool.kind === "tool") {
      expect(oldTool.content).toBe("[Decayed: ran old command]");
    }

    // The last two turns are protected outright, regardless of size.
    const recentTool = transcript.entries[5];
    expect(recentTool.kind).toBe("tool");
    if (recentTool.kind === "tool") {
      expect(recentTool.content).toBe(recentOutput);
    }
  });

  test("CB3 decay: a lone small stale entry below the free-floor is left untouched", () => {
    const smallOutput = "x".repeat(2500);
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Run a small old command" },
        { kind: "assistant", id: "a1", text: "", calls: [{ id: "c1", name: "bash", input: {} }] },
        { kind: "tool", callId: "c1", name: "bash", ok: true, content: smallOutput },
        { kind: "user", id: "u2", text: "Next turn" },
        { kind: "assistant", id: "a2", text: "Working...", calls: [] },
        { kind: "user", id: "u3", text: "Current turn" },
        { kind: "assistant", id: "a3", text: "Done", calls: [] },
      ],
      ephemeral: {},
    };

    const { decayedCount, decayedCallIds } = decayTranscript(transcript, { pruneOldToolOutputs: true });
    expect(decayedCount).toBe(0);
    expect(decayedCallIds).toEqual([]);
    const toolEntry = transcript.entries[2];
    expect(toolEntry.kind).toBe("tool");
    if (toolEntry.kind === "tool") {
      expect(toolEntry.content).toBe(smallOutput);
    }
  });

  // Follow-up to CB3 (2026-09-26) — mirrors opencode's `compaction.prune` default: pass 2 must sit
  // out entirely unless a caller opts in, even when the pass would otherwise have plenty to evict.
  test("pass 2 (age/budget eviction) is skipped entirely unless pruneOldToolOutputs is opted in", () => {
    const oldOutput = "x".repeat(90_000);
    const recentOutput = "y".repeat(200_000);
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Run an old big command" },
        { kind: "assistant", id: "a1", text: "", calls: [{ id: "c1", name: "bash", input: { command: "old" } }] },
        { kind: "tool", callId: "c1", name: "bash", ok: true, content: oldOutput, summary: "ran old command" },
        { kind: "user", id: "u2", text: "Run a recent big command" },
        { kind: "assistant", id: "a2", text: "", calls: [{ id: "c2", name: "bash", input: { command: "recent" } }] },
        { kind: "tool", callId: "c2", name: "bash", ok: true, content: recentOutput, summary: "ran recent command" },
        { kind: "user", id: "u3", text: "Current turn" },
        { kind: "assistant", id: "a3", text: "Done", calls: [] },
      ],
      ephemeral: {},
    };

    const withoutOptIn = decayTranscript(transcript);
    expect(withoutOptIn.decayedCount).toBe(0);
    expect(withoutOptIn.decayedCallIds).toEqual([]);
    const oldTool = transcript.entries[2];
    expect(oldTool.kind).toBe("tool");
    if (oldTool.kind === "tool") expect(oldTool.content).toBe(oldOutput);
  });

  test("CB3 decay: never touches todo or clarify output regardless of age or size", () => {
    const hugeOutput = "x".repeat(200_000);
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Track this" },
        {
          kind: "assistant",
          id: "a1",
          text: "",
          calls: [
            { id: "c1", name: "todo", input: {} },
            { id: "c2", name: "clarify", input: {} },
          ],
        },
        { kind: "tool", callId: "c1", name: "todo", ok: true, content: hugeOutput },
        { kind: "tool", callId: "c2", name: "clarify", ok: true, content: hugeOutput },
        { kind: "user", id: "u2", text: "Next turn" },
        { kind: "assistant", id: "a2", text: "Working...", calls: [] },
        { kind: "user", id: "u3", text: "Current turn" },
        { kind: "assistant", id: "a3", text: "Done", calls: [] },
      ],
      ephemeral: {},
    };

    const { decayedCount, decayedCallIds } = decayTranscript(transcript);
    expect(decayedCount).toBe(0);
    expect(decayedCallIds).toEqual([]);
  });

  test("CB3 decay: every browser snapshot before the latest is superseded, regardless of URL", () => {
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Look at the page" },
        { kind: "assistant", id: "a1", text: "", calls: [{ id: "s1", name: "browser", input: { op: "snapshot", url: "https://a.test" } }] },
        {
          kind: "tool",
          callId: "s1",
          name: "browser",
          ok: true,
          content: "snapshot tree 1 [ref=1] [ref=2]",
          summary: "snapshot of https://a.test — 2 interactive elements (gen 1)",
        },
        { kind: "assistant", id: "a2", text: "", calls: [{ id: "s2", name: "browser", input: { op: "snapshot" } }] },
        {
          kind: "tool",
          callId: "s2",
          name: "browser",
          ok: true,
          content: "snapshot tree 2 [ref=1] [ref=2] [ref=3]",
          summary: "snapshot of https://a.test — 3 interactive elements (gen 2)",
        },
      ],
      ephemeral: {},
    };

    const { decayedCallIds } = decayTranscript(transcript);
    expect(decayedCallIds).toEqual(["s1"]);

    const first = transcript.entries[2];
    expect(first.kind).toBe("tool");
    if (first.kind === "tool") {
      expect(first.content).toBe("[Superseded by a later browser snapshot — these refs are no longer valid]");
    }
    const second = transcript.entries[4];
    expect(second.kind).toBe("tool");
    if (second.kind === "tool") {
      expect(second.content).toBe("snapshot tree 2 [ref=1] [ref=2] [ref=3]");
    }
  });

  test("CB3 decay: grep/glob/bash repeated with byte-identical input supersedes the earlier call", () => {
    const transcript: Transcript = {
      entries: [
        { kind: "user", id: "u1", text: "Search for TODO twice" },
        { kind: "assistant", id: "a1", text: "", calls: [{ id: "g1", name: "grep", input: { pattern: "TODO" } }] },
        { kind: "tool", callId: "g1", name: "grep", ok: true, content: "3 matches (stale)" },
        { kind: "assistant", id: "a2", text: "", calls: [{ id: "g2", name: "grep", input: { pattern: "TODO" } }] },
        { kind: "tool", callId: "g2", name: "grep", ok: true, content: "5 matches (fresh)" },
        // A different pattern is a different call — never superseded by g1/g2.
        { kind: "assistant", id: "a3", text: "", calls: [{ id: "g3", name: "grep", input: { pattern: "FIXME" } }] },
        { kind: "tool", callId: "g3", name: "grep", ok: true, content: "1 match" },
      ],
      ephemeral: {},
    };

    const { decayedCallIds } = decayTranscript(transcript);
    expect(decayedCallIds).toEqual(["g1"]);
    expect((transcript.entries[2] as { content: string }).content).toBe(
      "[Superseded by an identical later grep call]"
    );
    expect((transcript.entries[4] as { content: string }).content).toBe("5 matches (fresh)");
    expect((transcript.entries[6] as { content: string }).content).toBe("1 match");
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
          // CB4 — large enough alone to cross computeSafeCutIndex's token budget, so this fixture
          // still produces a real cut instead of "nothing safe to cover yet" (a small transcript
          // that already fits in the raw-tail budget legitimately has nothing worth compacting).
          content: "// initial scaffold\n".repeat(10_000),
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
      // CB4 — pin the summarize-role lookup off so this test's outcome never depends on whatever
      // role happens to be configured in the shared DB (see the "wires the summarize role" describe
      // block below for the role-resolution behaviour itself).
      summarizeTarget: null,
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

  test("CB4: a large stale entry crosses the token budget and is excluded from the raw tail, while more than 2 recent entries stay", () => {
    const entries: TranscriptEntry[] = [
      { kind: "user", id: "u1", text: "Read the huge log file" },
      { kind: "assistant", id: "a1", text: "", calls: [{ id: "c1", name: "read", input: { path: "huge.log" } }] },
      // ~200k chars = ~50k tokens: alone exceeds RAW_TAIL_TOKEN_BUDGET (40k tokens / 160k chars).
      { kind: "tool", callId: "c1", name: "read", ok: true, content: "X".repeat(200_000) },
      { kind: "user", id: "u2", text: "Now summarize the recent turns" },
      { kind: "assistant", id: "a2", text: "Sure, one sec.", calls: [] },
      { kind: "user", id: "u3", text: "And also check the tests" },
      { kind: "assistant", id: "a3", text: "Checked, all green.", calls: [] },
    ];

    const safeCut = computeSafeCutIndex(entries);
    // Old fixed "last 2 entries" cut would have been entries.length - 2 = 5; the token-budget cut
    // stops earlier, right after the huge entry, keeping 4 recent entries raw instead of 2.
    expect(safeCut).toBe(3);
    expect(entries[safeCut]?.kind).toBe("user");
    expect(entries.slice(safeCut).length).toBeGreaterThan(2);

    const covered = entries.slice(0, safeCut);
    const tail = entries.slice(safeCut);
    const wire = project(
      { entries: [{ kind: "summary", id: "s1", covers: [], fields: { summary: `covers ${covered.length}` } }, ...tail], ephemeral: {} },
      { cacheStyle: "none", supportsMidConversationSystem: true }
    );
    expect(findOrphanToolMessage(wire)).toBeNull();
  });

  test("CB4: a token-budget cut that lands mid tool-result run still walks back to the owning assistant", () => {
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
      // Large enough that including it would blow the budget the instant the smaller c2 result
      // (below, walked first since the walk goes backward) is already in the tail.
      { kind: "tool", callId: "c1", name: "read", ok: true, content: "X".repeat(200_000) },
      { kind: "tool", callId: "c2", name: "read", ok: true, content: "two" },
    ];

    const safeCut = computeSafeCutIndex(entries);
    // The naive token-budget stop would land at index 3 (entries[3] is "tool" c2) — the walk-back
    // must move past both tool results to their owning assistant at index 1.
    expect(entries[safeCut]?.kind).not.toBe("tool");
    expect(safeCut).toBe(1);

    const tail = entries.slice(safeCut);
    const wire = project(
      { entries: [{ kind: "summary", id: "s1", covers: [], fields: { summary: "x" } }, ...tail], ephemeral: {} },
      { cacheStyle: "none", supportsMidConversationSystem: true }
    );
    expect(findOrphanToolMessage(wire)).toBeNull();
  });
});

describe("CB4: compactTranscript persists the compaction verdict", () => {
  test("createCompaction is written with the covered boundary, and the next buildTranscriptFromDb honours it", async () => {
    const proj = createProject({ name: "compact-cb4-test", path: "/tmp/compact-cb4-test" });
    const chat = createChat(proj.id, {});
    try {
      const m1 = appendMessage(chat.id, { role: "user", content: "Please inspect src/index.ts" });
      // Large enough to cross computeSafeCutIndex's token budget on its own, so the cut lands
      // here instead of walking all the way back to "nothing safe to cover yet" on a fixture this
      // small — mirrors how a real compaction is only ever triggered once the transcript is
      // already big.
      const m2 = appendMessage(chat.id, { role: "assistant", content: "X".repeat(200_000) });
      const m3 = appendMessage(chat.id, { role: "user", content: "Now add a test" });
      const m4 = appendMessage(chat.id, { role: "assistant", content: "Adding tests..." });

      const transcript: Transcript = {
        entries: [
          { kind: "user", id: m1.id, text: m1.content ?? "" },
          { kind: "assistant", id: m2.id, text: m2.content ?? "", calls: [] },
          { kind: "user", id: m3.id, text: m3.content ?? "" },
          { kind: "assistant", id: m4.id, text: m4.content ?? "", calls: [] },
        ],
        ephemeral: {},
      };

      const result = await compactTranscript({
        chatId: chat.id,
        transcript,
        providerRow: UNREACHABLE_PROVIDER_ROW,
        model: "mock-model",
        signal: new AbortController().signal,
        summarizeTarget: null,
      });
      expect(result.summary).toBeDefined();

      const persisted = getLatestCompaction(chat.id);
      expect(persisted).not.toBeNull();
      // covers [m1, m2] (m2's bulk is what crosses the budget); m3/m4 stay in the raw tail — so
      // the boundary is m2's seq, the last real message the summary actually covers.
      expect(persisted?.boundarySeq).toBe(m2.seq);

      // A fresh projection (as the next turn's runTurn would build) collapses everything up to
      // the boundary into one summary entry instead of re-summarizing it from scratch (CB4's
      // acceptance: compaction fires once, later turns don't repeat the work).
      const reloaded = buildTranscriptFromDb(chat.id);
      expect(reloaded.entries[0]?.kind).toBe("summary");
      const summaryEntry = reloaded.entries.find((e) => e.kind === "summary");
      expect(summaryEntry && summaryEntry.kind === "summary" ? summaryEntry.fields.summary : undefined).toBe(
        result.summary
      );
    } finally {
      deleteChat(chat.id);
      deleteProject(proj.id);
    }
  });
});
