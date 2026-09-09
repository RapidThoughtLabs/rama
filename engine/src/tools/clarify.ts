import { tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import type { ToolCtx, ToolResult } from "./types";

// docs/PROMPT_STACK_PLAN.md §8.1/§8.2, Phase PS6 — "the one worth building": a tool call is
// legible in a way prompt-only "ask if unclear" never is (the UI renders a real question card,
// not prose buried in an answer). §8.2's doctrine is encoded directly in the description and the
// schema's own limits, not left to the kernel prompt to repeat: at most 3 questions, only where
// different answers lead to materially different work, a default for each, never something a
// `grep` would answer.
const inputSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string(),
        default: z.string().optional().describe("A reasonable default if the user has no preference"),
      }),
    )
    .min(1)
    .max(3)
    .describe("At most 3. Only where different answers lead to materially different work."),
});

export function createClarifyTool(ctx: ToolCtx) {
  return tool({
    description:
      "Ask the user up to 3 clarifying questions before proceeding, each with a proposed default. Only for " +
      "genuine ambiguity where different answers lead to materially different work — never for something " +
      "you could answer yourself by reading the repo (grep/read/glob first). Calling this ends your turn: " +
      "the run pauses right after, and resumes as a normal new turn once the user answers.",
    inputSchema,
    // Low risk, no mode gating — asking a question can never itself change the project, and it
    // needs to be callable in plan/ask mode exactly as freely as in agent mode.
    execute: async (input): Promise<ToolResult> =>
      gate(ctx, { name: "clarify", input, risk: "low" }, async () => {
        const lines = input.questions.map((q, i) => `${i + 1}. ${q.question}${q.default ? ` (default: ${q.default})` : ""}`);
        return {
          ok: true,
          content: `Asked the user:\n${lines.join("\n")}\n\nRun paused — waiting for their answer.`,
          summary: `asked ${input.questions.length} question${input.questions.length === 1 ? "" : "s"}`,
        };
      }),
  });
}
