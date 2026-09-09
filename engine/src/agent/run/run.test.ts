// engine/src/agent/run/run.test.ts
//
// docs/LOOP_MENDING_PLAN.md MD0 — exit criteria for D1 ("the system prompt is never sent").
// buildProjectionContext is the single call site for buildPrompt() that both runTurn and
// getPromptPreview use; testing it directly is how we assert the two paths cannot diverge,
// since there is no fixture DB for chats/messages in this test suite (the real ~/.rama/rama.db
// is the only DB the engine talks to — see db/index.ts).

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { AgentDef } from "../agents/types";
import { defineTool, type RamaToolSet } from "../../tools/define";
import { sortTools } from "../prompt/toolInventory";
import { project, type Transcript } from "./transcript";
import { buildProjectionContext, describeOrphanedToolCallCause, reclassifyCompactionRetryError } from "./run";
import { LlmError } from "../../llm/types";

function fakeTool(description: string) {
  return defineTool({ description, inputSchema: z.object({}), execute: async () => "ok" });
}

function fakeTools(): RamaToolSet {
  return {
    read: fakeTool("Read a file."),
    write: fakeTool("Create or overwrite a file."),
  };
}

const AGENT: AgentDef = {
  name: "default",
  description: "No narrowing.",
  tools: null,
  mode: null,
  model: "chat",
  source: "bundled",
  path: "(test)",
  body: "",
};

function baseParams() {
  const tools = sortTools(fakeTools());
  return {
    providerId: "ollama",
    model: "llama3",
    tools,
    mode: "agent" as const,
    agent: AGENT,
    effectiveToolNames: Object.keys(tools),
    projectPath: process.cwd(),
  };
}

describe("buildProjectionContext (MD0)", () => {
  test("identical inputs produce the identical system stack — the guarantee that preview and run cannot diverge", () => {
    const a = buildProjectionContext(baseParams());
    const b = buildProjectionContext(baseParams());
    expect(a.promptBlocks.hash).toBe(b.promptBlocks.hash);
    expect(a.policy.system).toEqual(b.policy.system);
  });

  test("project() emits exactly the 3 buildPrompt blocks first, in order, before any transcript entry", () => {
    const { promptBlocks, policy } = buildProjectionContext(baseParams());
    expect(promptBlocks.system).toHaveLength(3);

    const transcript: Transcript = {
      entries: [{ kind: "user", id: "u1", text: "hello" }],
      ephemeral: {},
    };
    const wire = project(transcript, policy);

    expect(wire.slice(0, 3)).toEqual(promptBlocks.system);
    expect(wire[3]).toEqual({ role: "user", content: "hello" });
  });

  test("cache annotations on the system blocks survive projection untouched (unblocks G2)", () => {
    // ollama is catalog-configured as an OpenAI-compatible provider with automatic/none caching,
    // not explicit — so assert on whatever buildPrompt actually decided, rather than assuming.
    const { promptBlocks, policy } = buildProjectionContext(baseParams());
    const transcript: Transcript = { entries: [], ephemeral: {} };
    const wire = project(transcript, policy);
    for (let i = 0; i < promptBlocks.system.length; i++) {
      expect(wire[i].annotations?.cacheBreakpoint).toBe(promptBlocks.system[i].annotations?.cacheBreakpoint);
    }
  });

  test("an empty transcript with no ephemeral text projects to exactly the system stack — no phantom cache re-mark", () => {
    const { promptBlocks, policy } = buildProjectionContext(baseParams());
    const transcript: Transcript = { entries: [], ephemeral: {} };
    const wire = project(transcript, policy);
    expect(wire).toEqual(promptBlocks.system);
  });
});

describe("reclassifyCompactionRetryError (D2/MD2)", () => {
  test("a durable LlmError on the step right after compaction is downgraded to transient", () => {
    const original = new LlmError("bad request", "durable", { status: 400 });
    const result = reclassifyCompactionRetryError(original, true);
    expect(LlmError.isInstance(result)).toBe(true);
    if (LlmError.isInstance(result)) {
      expect(result.kind).toBe("transient");
      expect(result.status).toBe(400);
      expect(result.message).toBe("bad request");
    }
  });

  test("the same error passes through unchanged when it is not a compaction-retry step", () => {
    const original = new LlmError("bad request", "durable", { status: 400 });
    expect(reclassifyCompactionRetryError(original, false)).toBe(original);
  });

  test("an aborted error is never reclassified, even on a compaction-retry step", () => {
    const original = new LlmError("aborted", "aborted");
    expect(reclassifyCompactionRetryError(original, true)).toBe(original);
  });

  test("a non-LlmError passes through unchanged", () => {
    const original = new Error("network blip");
    expect(reclassifyCompactionRetryError(original, true)).toBe(original);
  });
});

describe("describeOrphanedToolCallCause (D11/MD3)", () => {
  test("interrupted-by-user names itself plainly", () => {
    expect(describeOrphanedToolCallCause("interrupted-by-user")).toBe("interrupted");
  });

  test("every other terminal state names itself, never falling back to a generic 'tool call failed'", () => {
    const states: Exclude<Parameters<typeof describeOrphanedToolCallCause>[0], "interrupted-by-user">[] = [
      "failed-permanent",
      "failed-transient-exhausted",
      "stopped-by-budget",
      "stopped-loop-detected",
      "stopped-output-truncated",
    ];
    for (const state of states) {
      const summary = describeOrphanedToolCallCause(state);
      expect(summary).toContain(state);
      expect(summary).not.toBe("tool call failed");
    }
  });
});
