// docs/PROMPT_STACK_PLAN.md §8.1/§8.2, Phase PS6 — createClarifyTool never touches ctx beyond
// gate()'s risk="low" path (which itself never reads ctx at all), so a minimal fixture is enough
// — same reasoning as search/providers/tools.ts's placeholder ToolCtx.
import { describe, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { createClarifyTool } from "./clarify";
import type { ToolCtx, ToolResult } from "./types";

// execute()'s return type includes the SDK's generic AsyncIterable streaming shape, which this
// tool never uses — every call here really returns a plain ToolResult.
async function run(tool: ReturnType<typeof createClarifyTool>, input: unknown): Promise<ToolResult> {
  return (await tool.execute!(input as never, {} as never)) as ToolResult;
}

function fakeCtx(mode: ToolCtx["mode"] = "agent"): ToolCtx {
  const chatId = "chat-1";
  return {
    chatId,
    projectId: "proj-1",
    projectPath: "/tmp/x",
    mode,
    abortSignal: new AbortController().signal,
    runId: "run-1",
    reads: undefined as unknown as ToolCtx["reads"],
    checkpoints: undefined as unknown as ToolCtx["checkpoints"],
    shell: undefined as unknown as ToolCtx["shell"],
    diagnostics: undefined as unknown as ToolCtx["diagnostics"],
    languageModel: "placeholder" as unknown as LanguageModel,
    subagentModel: "placeholder" as unknown as LanguageModel,
  };
}

describe("createClarifyTool", () => {
  test("asking one question with a default succeeds and echoes it back", async () => {
    const tool = createClarifyTool(fakeCtx());
    const result = await run(tool, { questions: [{ question: "Which file?", default: "src/index.ts" }] });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Which file?");
    expect(result.content).toContain("default: src/index.ts");
    expect(result.summary).toBe("asked 1 question");
  });

  test("plural summary for multiple questions", async () => {
    const tool = createClarifyTool(fakeCtx());
    const result = await run(tool, { questions: [{ question: "A?" }, { question: "B?" }] });
    expect(result.summary).toBe("asked 2 questions");
  });

  test("runs freely in plan mode — low risk is never blocked by gate()", async () => {
    const tool = createClarifyTool(fakeCtx("plan"));
    const result = await run(tool, { questions: [{ question: "A?" }] });
    expect(result.ok).toBe(true);
  });

  test("the schema caps at 3 questions", () => {
    const tool = createClarifyTool(fakeCtx());
    const parsed = (tool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }).safeParse({
      questions: [{ question: "1" }, { question: "2" }, { question: "3" }, { question: "4" }],
    });
    expect(parsed.success).toBe(false);
  });
});
