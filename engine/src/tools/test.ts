import { defineTool, type RamaTool } from "./define";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createCheckTool } from "./check";
import { createEditTool } from "./edit";
import { createGitTool } from "./git";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createOutlineTool } from "./outline";
import { createReadTool } from "./read";
import { getWorkingDiff, truncateDiff } from "./subagentDiff";
import { runSubagent, SUBAGENT_RETURN_CONTRACT } from "./subagentRunner";
import { createTreeTool } from "./tree";
import type { ToolCtx, ToolResult } from "./types";
import { createWriteTool } from "./write";

// docs/PROMPT_STACK_PLAN.md §6.4, Phase PS5 — third member of the roster, and "the proof the
// format earns its keep" (§5.2's narrowing allowlist doing real work): this sub-agent can write,
// but only to files that look like tests. A path outside that pattern is refused before it ever
// reaches the real write/edit tool, regardless of what the sub-agent's own model decides to do.
const STEP_BUDGET = 15;
const ANSWER_MAX_CHARS = 6_000;
const TEST_PATH_RE = /(\.test\.|\.spec\.|(^|\/)(__tests__|tests?)\/)/i;

function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

// Wraps the real write/edit tools with a path check ahead of their own execute — every other
// guarantee they already provide (checkpoints, read-before-write, the shrink guard, the
// post-write typecheck) still applies; this only adds "must look like a test file". The pass-
// through is untyped on purpose: `real`'s own zod inputSchema (reused verbatim below) is the
// actual input contract, enforced by the AI SDK before `execute` ever runs.
function scopeToTestPaths(toolName: string, real: RamaTool): RamaTool {
  return defineTool({
    description: real.description,
    inputSchema: z.object({ path: z.string() }),
    execute: async (input: { path: string }, options) => {
      if (!isTestPath(input.path)) {
        const msg = `refused: "${input.path}" doesn't look like a test file — this tool can only ${toolName} test files (*.test.*, *.spec.*, __tests__/, tests?/).`;
        return { ok: false, summary: "refused: not a test file", content: msg };
      }
      return real.execute(input, options);
    },
  });
}

const TEST_ROLE_PROMPT =
  "You write and run tests for a change you did not write, using the diff below for context. You do " +
  "not have the conversation that produced it, deliberately. You may only write or edit files that " +
  "look like test files (*.test.*, *.spec.*, __tests__/, tests?/) — write/edit on anything else is " +
  "refused automatically, so don't try to fix the change itself, even if it looks wrong: report that " +
  "instead. Use `check` (kinds: [\"test\"]) to actually run the suite after writing tests, and report " +
  "the real result — pass or fail with the failure output — not just that you wrote something.";

const TEST_SYSTEM_PROMPT = `${TEST_ROLE_PROMPT}\n\n${SUBAGENT_RETURN_CONTRACT}`;

export function createTestTool(ctx: ToolCtx) {
  return defineTool({
    description:
      "Delegate writing (and running) tests for the current diff to a fresh sub-agent scoped to " +
      "test files only — it cannot touch non-test source, so it cannot silently 'fix' the change " +
      "instead of testing it. Context is the diff and the repo, not this conversation. Returns " +
      "what it wrote and whether the suite passed.",
    inputSchema: z.object({
      against: z.string().optional().describe("Git ref to diff against, e.g. a base branch. Defaults to HEAD (uncommitted changes)."),
      focus: z.string().optional().describe("What to prioritize testing, if anything specific."),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "test", input, risk: "high" }, async () => {
        const { diff, empty } = await getWorkingDiff(ctx.projectPath, input.against);
        if (empty) {
          return { ok: true, summary: "no changes to test", content: "no diff — nothing to write tests for" };
        }

        const realWrite = createWriteTool(ctx);
        const realEdit = createEditTool(ctx);
        const subTools = {
          read: createReadTool(ctx),
          glob: createGlobTool(ctx),
          grep: createGrepTool(ctx),
          tree: createTreeTool(ctx),
          outline: createOutlineTool(ctx),
          git: createGitTool(ctx),
          check: createCheckTool(ctx),
          write: scopeToTestPaths("write", realWrite),
          edit: scopeToTestPaths("edit", realEdit),
        };

        const briefing = [
          `diff${input.against ? ` (against ${input.against})` : " (uncommitted changes)"}:`,
          "```diff",
          truncateDiff(diff),
          "```",
          input.focus ? `focus: ${input.focus}` : null,
        ]
          .filter((l): l is string => l !== null)
          .join("\n");

        return runSubagent({
          ctx,
          toolCallId: options.toolCallId,
          model: ctx.subagentModel,
          system: TEST_SYSTEM_PROMPT,
          userContent: briefing,
          tools: subTools,
          stepBudget: STEP_BUDGET,
          answerMaxChars: ANSWER_MAX_CHARS,
          logTag: "test",
          artifactName: `test: ${input.against ?? "uncommitted changes"}`,
          summaryLabel: "tests written",
          noAnswerMessage: "(the sub-agent ran but reported no result — check the artifact transcript)",
        });
      }),
  });
}
