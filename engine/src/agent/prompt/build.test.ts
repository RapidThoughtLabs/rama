// docs/PROMPT_STACK_PLAN.md Phase PS0/PS1/PS2/PS3/PS4 — the standing assertion §13 Risk 1 calls
// "not optional": a cache regression never errors, so this is the only thing that would ever
// catch one. build.ts/cache.ts/toolInventory.ts/mode.ts/agent.ts/project.ts/ephemeral.ts are all
// pure and synchronous (ephemeral.ts's own I/O half, getVolatileEnv, is intentionally untested
// here — it's a thin git-status wrapper, not logic), so none of this needs a DB, a fixture
// project, or a network call.

import { describe, expect, test } from "bun:test";
import { defineTool, type RamaToolSet } from "../../tools/define";
import { z } from "zod";
import type { AgentDef } from "../agents/types";
import type { CachePolicy } from "../catalog";
import { buildAgentBlock } from "./agent";
import { buildPrompt, type PromptInputs } from "./build";
import { formatEffectiveToolsNote } from "./effectiveToolsNote";
import { buildEphemeralMessage, buildEphemeralText, formatVolatileEnv } from "./ephemeral";
import { buildModeBlock } from "./mode";
import { formatProjectKnowledge } from "./project";
import { getStaticEnv } from "./sources";
import { generateToolInventory, sortTools } from "./toolInventory";

function fakeTool(description: string) {
  return defineTool({ description, inputSchema: z.object({}), execute: async () => "ok" });
}

function fakeTools(): RamaToolSet {
  return {
    write: fakeTool("Create or overwrite a file."),
    bash: fakeTool("Run a shell command."),
    read: fakeTool("Read a file."),
  };
}

const EXPLICIT: CachePolicy = { style: "explicit", minTokens: 1024, readMultiplier: 0.1, writeMultiplier: 1.25 };
const AUTOMATIC: CachePolicy = { style: "automatic", minTokens: null, readMultiplier: 1, writeMultiplier: 1 };

const DEFAULT_AGENT: AgentDef = {
  name: "default",
  description: "No narrowing.",
  tools: null,
  mode: null,
  model: "chat",
  source: "bundled",
  path: "(test)",
  body: "",
};

function fakeAgent(overrides: Partial<AgentDef> = {}): AgentDef {
  return { ...DEFAULT_AGENT, ...overrides };
}

function inputs(overrides: Partial<PromptInputs> = {}): PromptInputs {
  const tools = overrides.tools ?? sortTools(fakeTools());
  return {
    tools,
    hekuManifest: "",
    staticEnv: getStaticEnv(),
    cache: AUTOMATIC,
    mode: "agent",
    agent: DEFAULT_AGENT,
    effectiveToolNames: Object.keys(tools),
    projectKnowledge: { global: null, project: null, extraRoots: [] },
    ...overrides,
  };
}

describe("sortTools", () => {
  test("sorts by name regardless of insertion order", () => {
    expect(Object.keys(sortTools(fakeTools()))).toEqual(["bash", "read", "write"]);
  });
});

describe("generateToolInventory", () => {
  test("names every tool in the sorted map, using its real description", () => {
    const inventory = generateToolInventory(sortTools(fakeTools()));
    expect(inventory).toContain("- bash: Run a shell command.");
    expect(inventory).toContain("- read: Read a file.");
    expect(inventory).toContain("- write: Create or overwrite a file.");
    expect(inventory).toContain("You have 3 tools this turn");
  });
});

describe("buildPrompt", () => {
  test("identical inputs produce a byte-identical prefix (PS0 exit criterion)", () => {
    const a = buildPrompt(inputs());
    const b = buildPrompt(inputs());
    expect(a.hash).toBe(b.hash);
    expect(a.system[0].content).toBe(b.system[0].content);
  });

  test("the tool inventory always matches the tool map passed in — never drifts", () => {
    const tools = sortTools(fakeTools());
    const { system } = buildPrompt(inputs({ tools }));
    const content = system[0].content;
    for (const name of Object.keys(tools)) expect(content).toContain(`- ${name}:`);
  });

  test("a different tool set changes the hash", () => {
    const a = buildPrompt(inputs());
    const b = buildPrompt(inputs({ tools: sortTools({ ...fakeTools(), edit: fakeTool("Edit a file.") }) }));
    expect(a.hash).not.toBe(b.hash);
  });

  test("no cache_control on an automatic-caching provider", () => {
    const { system, blocks } = buildPrompt(inputs({ cache: AUTOMATIC }));
    for (const message of system) expect(message.annotations?.cacheBreakpoint).toBeUndefined();
    expect(blocks.every((b) => !b.cached)).toBe(true);
  });

  test("cache_control on every block for an explicit-caching provider — bp1/bp2 (CB5/D5: 2 system blocks, freeing 2 breakpoints for the conversation-tail anchors)", () => {
    const { system, blocks } = buildPrompt(inputs({ cache: EXPLICIT }));
    expect(system).toHaveLength(2);
    for (const message of system) {
      expect(message.annotations?.cacheBreakpoint).toBe(true);
    }
    expect(blocks.every((b) => b.cached)).toBe(true);
  });

  test("mode text is in the merged agent+mode+project+env block (bp2), not the kernel block (bp1)", () => {
    const plan = buildPrompt(inputs({ mode: "plan" }));
    expect(plan.blocks[0].label).toBe("kernel+tools");
    expect(plan.blocks[1].label).toBe("agent+mode+project+env");
    expect(plan.blocks[0].content).not.toContain("Mode: plan");
    expect(plan.blocks[1].content).toContain("Mode: plan");
  });

  test("switching mode changes only bp2's content, not kernel+tools (bp1 stays warm)", () => {
    const agentMode = buildPrompt(inputs({ mode: "agent" }));
    const plan = buildPrompt(inputs({ mode: "plan" }));
    expect(agentMode.blocks[0].content).toBe(plan.blocks[0].content);
    expect(agentMode.blocks[1].content).not.toBe(plan.blocks[1].content);
    expect(agentMode.hash).not.toBe(plan.hash);
  });

  test("agent body renders in bp2 alongside mode text, never in the kernel block", () => {
    const reviewer = fakeAgent({ name: "reviewer", body: "You review changes you did not write." });
    const { blocks } = buildPrompt(inputs({ agent: reviewer }));
    expect(blocks[1].content).toContain("You review changes you did not write.");
    expect(blocks[0].content).not.toContain("You review changes you did not write.");
  });

  test("switching agent (same mode) invalidates only bp2, keeps kernel+tools warm (PS4 exit criterion)", () => {
    const withDefault = buildPrompt(inputs({ agent: DEFAULT_AGENT }));
    const withReviewer = buildPrompt(inputs({ agent: fakeAgent({ name: "reviewer", body: "Review only." }) }));
    expect(withDefault.blocks[0].content).toBe(withReviewer.blocks[0].content);
    expect(withDefault.blocks[1].content).not.toBe(withReviewer.blocks[1].content);
    expect(withDefault.hash).not.toBe(withReviewer.hash);
  });

  test("an agent with no body (the bundled floor) renders no agent header at all", () => {
    const { blocks } = buildPrompt(inputs({ agent: fakeAgent({ body: "" }) }));
    expect(blocks[1].content).not.toContain("Agent:");
  });

  test("an unnarrowed toolset adds no note to bp2 (the common-case cost is zero)", () => {
    const tools = sortTools(fakeTools());
    const { blocks } = buildPrompt(inputs({ tools, effectiveToolNames: Object.keys(tools) }));
    expect(blocks[1].content).not.toContain("Your actual toolset this turn");
  });

  test("a narrowed toolset adds the effective-tools note to bp2, never to bp1", () => {
    const tools = sortTools(fakeTools());
    const { blocks } = buildPrompt(inputs({ tools, effectiveToolNames: ["read"] }));
    expect(blocks[1].content).toContain("Your actual toolset this turn");
    expect(blocks[1].content).toContain("read");
    expect(blocks[0].content).not.toContain("Your actual toolset this turn");
  });

  test("project knowledge renders in bp2, alongside static env, never the kernel block", () => {
    const { blocks } = buildPrompt(inputs({ projectKnowledge: { global: "use bun", project: null, extraRoots: [] } }));
    expect(blocks[1].label).toBe("agent+mode+project+env");
    expect(blocks[1].content).toContain("use bun");
    expect(blocks[0].content).not.toContain("use bun");
  });

  test("extra context folders render as pointers in bp2, never dumped into bp1", () => {
    const { blocks } = buildPrompt(
      inputs({ projectKnowledge: { global: null, project: null, extraRoots: ["/Users/x/other-repo"] } }),
    );
    expect(blocks[1].content).toContain("/Users/x/other-repo");
    expect(blocks[1].content).toContain("read-only");
    expect(blocks[0].content).not.toContain("/Users/x/other-repo");
  });

  test("no RAMA.md anywhere still produces non-empty bp2 content (static env alone)", () => {
    const { blocks } = buildPrompt(inputs());
    expect(blocks[1].content.length).toBeGreaterThan(0);
    expect(blocks[1].content).not.toContain("instructions");
  });
});

describe("buildModeBlock", () => {
  test("plan mode names the read-only block and the 3-question doctrine (§8.2 exit criterion)", () => {
    const text = buildModeBlock("plan");
    expect(text).toContain("read-only");
    expect(text).toContain("at most 3 clarifying questions");
  });

  test("every mode produces distinct, non-empty text", () => {
    const agent = buildModeBlock("agent");
    const plan = buildModeBlock("plan");
    const ask = buildModeBlock("ask");
    expect(new Set([agent, plan, ask]).size).toBe(3);
    for (const text of [agent, plan, ask]) expect(text.length).toBeGreaterThan(0);
  });
});

describe("buildAgentBlock", () => {
  test("empty body (the bundled default agent) renders nothing", () => {
    expect(buildAgentBlock(fakeAgent({ body: "" }))).toBe("");
  });

  test("a real agent renders its name, description, and body", () => {
    const text = buildAgentBlock(fakeAgent({ name: "reviewer", description: "Reviews diffs.", body: "Cite every finding." }));
    expect(text).toContain("Agent: reviewer. Reviews diffs.");
    expect(text).toContain("Cite every finding.");
  });
});

describe("formatEffectiveToolsNote", () => {
  test("empty when nothing was narrowed", () => {
    expect(formatEffectiveToolsNote(["read", "write"], ["read", "write"])).toBe("");
  });

  test("names the narrower set when something was removed", () => {
    const text = formatEffectiveToolsNote(["read"], ["read", "write", "bash"]);
    expect(text).toContain("read");
    expect(text).not.toContain("write");
  });

  test("says so plainly when narrowed down to nothing", () => {
    expect(formatEffectiveToolsNote([], ["read", "write"])).toContain("none");
  });
});

describe("formatProjectKnowledge", () => {
  test("a project whose RAMA.md says 'use bun' is present verbatim (PS3 exit criterion)", () => {
    const text = formatProjectKnowledge({ global: null, project: "use bun, not npm, for everything.", extraRoots: [] });
    expect(text).toContain("use bun, not npm, for everything.");
  });

  test("empty when neither doc exists and there are no extra roots", () => {
    expect(formatProjectKnowledge({ global: null, project: null, extraRoots: [] })).toBe("");
  });

  test("both docs render with distinct headers, global first", () => {
    const text = formatProjectKnowledge({ global: "g", project: "p", extraRoots: [] });
    expect(text.indexOf("Global")).toBeLessThan(text.indexOf("Project"));
  });

  // docs/COMPOSER_CONTEXT_PLAN.md Phase CC1 — a pointer (the path), never the folder's contents.
  test("extra roots render as an absolute-path list, not file contents", () => {
    const text = formatProjectKnowledge({ global: null, project: null, extraRoots: ["/a/b", "/c/d"] });
    expect(text).toContain("/a/b");
    expect(text).toContain("/c/d");
    expect(text).toContain("Additional context folders");
  });
});

describe("ephemeral block", () => {
  test("formatVolatileEnv reports a clean, non-git repo", () => {
    const text = formatVolatileEnv({ date: "2026-09-08", git: null });
    expect(text).toBe("Date: 2026-09-08. not a git repository.");
  });

  test("formatVolatileEnv reports branch + dirty state", () => {
    const text = formatVolatileEnv({ date: "2026-09-08", git: { branch: "main", dirty: true } });
    expect(text).toBe("Date: 2026-09-08. git branch main, dirty.");
  });

  test("buildEphemeralText wraps volatile env in a system-reminder tag; todo/budget are reserved and unwired", () => {
    const text = buildEphemeralText({ volatileEnv: { date: "2026-09-08", git: null } });
    expect(text).toContain('<system-reminder id="ephemeral-env">');
    expect(text).toContain("Date: 2026-09-08");
  });

  test("buildEphemeralMessage: trailing role:system when supported, text-in-user fallback otherwise", () => {
    const text = "the ephemeral text";
    expect(buildEphemeralMessage(text, true)).toEqual({ role: "system", content: text });
    expect(buildEphemeralMessage(text, false)).toEqual({ role: "user", content: text });
  });
});
