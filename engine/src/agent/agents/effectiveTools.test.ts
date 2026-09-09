// docs/PROMPT_STACK_PLAN.md §5.2, Phase PS4 — "an agent's tool list may only narrow, never widen.
// The effective toolset is harness tools ∩ mode allowance ∩ agent allowlist." This is the exit
// criterion test: "an agent file requesting a tool the mode forbids gets nothing."

import { describe, expect, test } from "bun:test";
import { defineTool, type RamaToolSet } from "../../tools/define";
import { z } from "zod";
import { computeEffectiveTools } from "./effectiveTools";
import type { AgentDef } from "./types";

function fakeTool() {
  return defineTool({ description: "x", inputSchema: z.object({}), execute: async () => "ok" });
}

function harnessTools(): RamaToolSet {
  return {
    read: fakeTool(),
    grep: fakeTool(),
    write: fakeTool(),
    bash: fakeTool(),
    skill_foo: fakeTool(),
    heku_find: fakeTool(),
  };
}

function fakeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return { name: "test", description: "", tools: null, mode: null, model: "chat", source: "bundled", path: "(test)", body: "", ...overrides };
}

describe("computeEffectiveTools", () => {
  test("an unrestricted agent (tools: null) in agent mode gets everything", () => {
    const out = computeEffectiveTools(harnessTools(), "agent", fakeAgent());
    expect(Object.keys(out).sort()).toEqual(["bash", "grep", "heku_find", "read", "skill_foo", "write"]);
  });

  test("plan mode removes high-risk harness tools entirely, even for an unrestricted agent", () => {
    const out = computeEffectiveTools(harnessTools(), "plan", fakeAgent());
    expect(out.write).toBeUndefined();
    expect(out.bash).toBeUndefined();
    expect(out.read).toBeDefined();
    expect(out.grep).toBeDefined();
  });

  test("an agent allowlist narrows within a mode that would otherwise allow more", () => {
    const out = computeEffectiveTools(harnessTools(), "agent", fakeAgent({ tools: ["read", "grep"] }));
    expect(out.read).toBeDefined();
    expect(out.grep).toBeDefined();
    expect(out.write).toBeUndefined();
    expect(out.bash).toBeUndefined();
  });

  test("agent requesting a tool mode forbids gets nothing — mode always wins (PS4 exit criterion)", () => {
    const out = computeEffectiveTools(harnessTools(), "plan", fakeAgent({ tools: ["read", "write", "bash"] }));
    expect(out.read).toBeDefined();
    expect(out.write).toBeUndefined();
    expect(out.bash).toBeUndefined();
  });

  test("skill_*/heku_* tools are never narrowed by an agent allowlist", () => {
    const out = computeEffectiveTools(harnessTools(), "agent", fakeAgent({ tools: ["read"] }));
    expect(out.skill_foo).toBeDefined();
    expect(out.heku_find).toBeDefined();
    expect(out.grep).toBeUndefined();
  });
});
