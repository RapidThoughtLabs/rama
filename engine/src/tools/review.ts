import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createGitTool } from "./git";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createOutlineTool } from "./outline";
import { createReadTool } from "./read";
import { getWorkingDiff, truncateDiff } from "./subagentDiff";
import { runSubagent, SUBAGENT_RETURN_CONTRACT } from "./subagentRunner";
import { createTreeTool } from "./tree";
import type { ToolCtx, ToolResult } from "./types";

// docs/PROMPT_STACK_PLAN.md §6.4, Phase PS5 — second member of the roster. Deliberately does NOT
// get the parent conversation: the author already knows what they meant, so a reviewer that only
// sees the diff and the repo catches what the author structurally cannot. Read-only, same as
// `explore` — a finding is a report, not a fix.
const STEP_BUDGET = 15;
const ANSWER_MAX_CHARS = 6_000;

const REVIEW_ROLE_PROMPT =
  "You review a diff for correctness bugs — not style preferences, not architecture opinions. You do " +
  "not have the conversation that produced this diff, deliberately: the author already knows what they " +
  "meant, so read the diff and the surrounding code and judge what it actually does, not what it was " +
  "supposed to do. You have read-only tools: read, glob, grep, tree, outline, git — no write access, " +
  "no shell. Report findings as a list, most severe first, each with a real file:line citation and a " +
  "one-sentence description of the concrete failure it causes. If you find nothing wrong, say so " +
  "plainly — never invent findings to seem thorough.";

const REVIEW_SYSTEM_PROMPT = `${REVIEW_ROLE_PROMPT}\n\n${SUBAGENT_RETURN_CONTRACT}`;

export function createReviewTool(ctx: ToolCtx) {
  return tool({
    description:
      "Review the current diff (uncommitted changes by default, or against a base ref) for correctness " +
      "bugs, using a fresh read-only sub-agent that sees only the diff and the repo — not this " +
      "conversation. Use this before finishing a change, or when you want a second, unbiased pass. " +
      "Returns findings, most severe first, with cited paths.",
    inputSchema: z.object({
      against: z.string().optional().describe("Git ref to diff against, e.g. a base branch. Defaults to HEAD (uncommitted changes)."),
      focus: z.string().optional().describe("A specific area or concern to focus the review on, if any."),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "review", input, risk: "low" }, async () => {
        const { diff, empty } = await getWorkingDiff(ctx.projectPath, input.against);
        if (empty) {
          return { ok: true, summary: "no changes to review", content: "no diff — nothing to review" };
        }

        const subTools = {
          read: createReadTool(ctx),
          glob: createGlobTool(ctx),
          grep: createGrepTool(ctx),
          tree: createTreeTool(ctx),
          outline: createOutlineTool(ctx),
          git: createGitTool(ctx),
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
          system: REVIEW_SYSTEM_PROMPT,
          userContent: briefing,
          tools: subTools,
          stepBudget: STEP_BUDGET,
          answerMaxChars: ANSWER_MAX_CHARS,
          logTag: "review",
          artifactName: `review: ${input.against ?? "uncommitted changes"}`,
          summaryLabel: "review complete",
          noAnswerMessage: "(the sub-agent read the diff but produced no findings — try again with a narrower `focus`)",
        });
      }),
  });
}
