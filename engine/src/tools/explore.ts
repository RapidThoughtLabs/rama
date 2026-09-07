import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { gate } from "../agent/permissions";
import { createArtifact } from "../db/artifacts";
import { createGlobTool } from "./glob";
import { createGrepTool } from "./grep";
import { createOutlineTool } from "./outline";
import { createReadTool } from "./read";
import { createTreeTool } from "./tree";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

// docs/TOOL_LAYER_PLAN.md §6.15 (TL6) — "the cheapest context lever available." A question that
// needs thirty reads to answer should cost the parent one paragraph, not thirty file bodies; no
// compaction pass recovers those tokens as well as never spending them.
const STEP_BUDGET = 12;
const ANSWER_MAX_CHARS = 6_000;

const EXPLORE_SYSTEM_PROMPT =
  "You are a read-only research assistant answering one specific question about a codebase, for " +
  "another assistant that will act on your answer without re-checking it. You have five tools: " +
  "read, glob, grep, tree, outline — no write access, no shell, no git, nothing else. Investigate " +
  "efficiently, then answer in prose. Cite every claim with a real file path (and line number " +
  "where it matters, e.g. `src/foo.ts:42`) so the answer can be verified — never paraphrase from " +
  "memory or guess at a path you have not actually seen in a tool result. Be concise: a few " +
  "paragraphs at most, not a transcript of what you read. If the codebase does not answer the " +
  "question, say so plainly instead of inventing something plausible.";

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
      hint: z.string().optional().describe("Where to start looking, if you know."),
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

        const userContent = input.hint ? `${input.question}\n\n(hint: ${input.hint})` : input.question;
        const transcript: string[] = [`question: ${input.question}`, ...(input.hint ? [`hint: ${input.hint}`] : [])];
        let finalText = "";

        try {
          const result = streamText({
            model: ctx.languageModel,
            system: EXPLORE_SYSTEM_PROMPT,
            messages: [{ role: "user", content: userContent }],
            tools: subTools,
            stopWhen: stepCountIs(STEP_BUDGET),
            abortSignal: ctx.abortSignal,
            onError: ({ error }) => {
              console.error(`[explore] nested stream error (chat ${ctx.chatId}):`, error instanceof Error ? error.message : error);
            },
          });

          for await (const part of result.fullStream) {
            switch (part.type) {
              case "text-delta":
                finalText += part.text;
                break;
              case "tool-call":
                transcript.push(`\n> ${part.toolName}(${JSON.stringify(part.input)})`);
                break;
              case "tool-result": {
                const output = part.output as ToolResult;
                transcript.push(output.content ?? output.summary);
                break;
              }
              case "tool-error": {
                const message = part.error instanceof Error ? part.error.message : String(part.error);
                transcript.push(`error: ${message}`);
                break;
              }
              case "error":
                throw part.error instanceof Error ? part.error : new Error(String(part.error));
              default:
                break;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return { ok: false, summary: "explore sub-run failed", content: `explore failed: ${message}` };
        }

        const answer = finalText.trim() || "(the sub-agent read the codebase but produced no final answer — try a narrower question)";
        transcript.push(`\n--- answer ---\n${answer}`);

        const artifact = createArtifact({
          chatId: ctx.chatId,
          projectId: ctx.projectId,
          toolCallId: options.toolCallId,
          kind: "doc",
          name: `explore: ${input.question}`,
          meta: {},
          body: transcript.join("\n"),
        });

        const { content, truncated } = headTailTruncate(answer, ANSWER_MAX_CHARS);
        return {
          ok: true,
          content,
          summary: input.question.length > 80 ? `${input.question.slice(0, 77)}...` : input.question,
          artifactId: artifact.id,
          meta: truncated
            ? {
                truncated: {
                  shown: ANSWER_MAX_CHARS,
                  total: answer.length,
                  unit: "bytes" as const,
                  how: "the sub-agent's answer ran long — ask a narrower question next time",
                },
              }
            : undefined,
        };
      }),
  });
}
