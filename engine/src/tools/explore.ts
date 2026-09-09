import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createOutlineTool } from "./outline";
import { createReadTool } from "./read";
import { runSubagent, SUBAGENT_RETURN_CONTRACT } from "./subagentRunner";
import { createTreeTool } from "./tree";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.15 (TL6) / docs/PROMPT_STACK_PLAN.md §6 (PS5) — "the cheapest context
// lever available." A question that needs thirty reads to answer should cost the parent one
// paragraph, not thirty file bodies; no compaction pass recovers those tokens as well as never
// spending them. Runs on the `subagent` model role (ctx.subagentModel), not the parent's own —
// PS5 reverses TL6's original "same model by default" (§6.1: a sub-agent is a cost transfer).
const STEP_BUDGET = 12;
const ANSWER_MAX_CHARS = 6_000;

const EXPLORE_ROLE_PROMPT =
  "You are a read-only research assistant answering one specific question about a codebase, for " +
  "another assistant that will act on your answer without re-checking it. You have five tools: " +
  "read, glob, grep, tree, outline — no write access, no shell, no git, nothing else. Investigate " +
  "efficiently, then answer in prose — a few paragraphs at most, not a transcript of what you read. " +
  "If the codebase does not answer the question, say so plainly instead of inventing something " +
  "plausible.";

const EXPLORE_SYSTEM_PROMPT = `${EXPLORE_ROLE_PROMPT}\n\n${SUBAGENT_RETURN_CONTRACT}`;

export function createExploreTool(ctx: ToolCtx) {
  return tool({
    description:
      "Delegate a specific, answerable-from-the-codebase question to an isolated read-only " +
      'sub-agent — "where is X defined", "how does Y flow through the system", "why is Z built ' +
      'this way" — and get back a prose answer with cited paths, instead of spending your own ' +
      "context on the reads yourself. Not for anything that needs to write a file or run a " +
      "command; use your own tools for that. The sub-agent's full transcript is saved to the " +
      "artifacts panel for audit; only its final answer enters your context.",
    inputSchema: z.object({
      question: z.string().describe("A specific question about the codebase, answered by reading it."),
      known: z.string().optional().describe("What you've already established, so the sub-agent doesn't re-derive it."),
      start: z.string().optional().describe("Where to look first, if you know."),
      outOfScope: z.string().optional().describe("What the sub-agent shouldn't bother checking."),
      budget: z.number().int().positive().optional().describe(`Step budget for this run, capped at ${STEP_BUDGET} (the default).`),
    }),
    execute: async (input, options): Promise<ToolResult> =>
      gate(ctx, { name: "explore", input, risk: "low" }, async () => {
        const subTools = {
          read: createReadTool(ctx),
          glob: createGlobTool(ctx),
          grep: createGrepTool(ctx),
          tree: createTreeTool(ctx),
          outline: createOutlineTool(ctx),
        };

        // docs/PROMPT_STACK_PLAN.md §6.2 — the briefing slot: question/known/start/out-of-scope/
        // budget, the one part of a sub-agent's prompt that varies. Everything else (the role
        // text + return contract above) is fixed and cacheable.
        const briefing = [
          `question: ${input.question}`,
          input.known ? `known: ${input.known}` : null,
          input.start ? `start: ${input.start}` : null,
          input.outOfScope ? `out-of-scope: ${input.outOfScope}` : null,
        ]
          .filter((l): l is string => l !== null)
          .join("\n");
        const stepBudget = input.budget ? Math.min(input.budget, STEP_BUDGET) : STEP_BUDGET;

        return runSubagent({
          ctx,
          toolCallId: options.toolCallId,
          model: ctx.subagentModel,
          system: EXPLORE_SYSTEM_PROMPT,
          userContent: briefing,
          tools: subTools,
          stepBudget,
          answerMaxChars: ANSWER_MAX_CHARS,
          logTag: "explore",
          artifactName: `explore: ${input.question}`,
          summaryLabel: input.question.length > 80 ? `${input.question.slice(0, 77)}...` : input.question,
          noAnswerMessage: "(the sub-agent read the codebase but produced no final answer — try a narrower question)",
        });
      }),
  });
}
