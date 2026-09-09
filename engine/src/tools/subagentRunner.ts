import { stepCountIs, streamText, type LanguageModel, type ToolSet } from "ai";
import { createArtifact } from "../db/artifacts";
import { headTailTruncate } from "./truncate";
import type { ToolCtx, ToolResult } from "./types";

// docs/PROMPT_STACK_PLAN.md §6.3, Phase PS5 — the base sub-agent prompt, shared verbatim by
// explore/review/test (§6.4: "all three are instances of §5.3's format with §6.3's contract").
// Each row in the plan's table is one sentence here; the last row (confidence + what was NOT
// checked) is the one the plan calls out as "the one people skip and the most valuable".
export const SUBAGENT_RETURN_CONTRACT =
  "Before answering, restate the question or task in one line, so it's clear you answered the one " +
  "actually asked. Cite a real file path (and line number where it matters, e.g. `src/foo.ts:42`) for " +
  "every claim — never paraphrase from memory or guess at a path you have not actually seen in a tool " +
  "result. If the briefing you were given includes prior findings or established facts, treat them as " +
  "authoritative — don't re-derive what's already known. You have a fixed step budget for this run; if " +
  "you are not converging, say so rather than spending it all and returning nothing. End with your " +
  "confidence in the answer and, explicitly, what you did NOT check — that is what lets the caller " +
  "decide whether to trust the result or spend a step re-verifying it.";

export interface SubagentRunOptions {
  ctx: ToolCtx;
  toolCallId: string;
  model: LanguageModel;
  system: string;
  userContent: string;
  tools: ToolSet;
  stepBudget: number;
  answerMaxChars: number;
  /** Tags console error logs and the artifact name prefix, e.g. "explore", "review", "test". */
  logTag: string;
  artifactName: string;
  summaryLabel: string;
  noAnswerMessage: string;
}

// docs/TOOL_LAYER_PLAN.md §6.15 / docs/PROMPT_STACK_PLAN.md §6, Phase PS5 — the nested-streamText
// engine shared by explore/review/test (factored out of what was explore.ts's own inline loop).
// Sub-agent output enters the parent's context as data (§6.3's closing line) — only `content`
// below is ever routed into the parent's message stream; the full transcript goes to the
// artifacts panel for audit and never reaches the model.
export async function runSubagent(opts: SubagentRunOptions): Promise<ToolResult> {
  const { ctx, toolCallId, model, system, userContent, tools, stepBudget, answerMaxChars, logTag, artifactName, summaryLabel, noAnswerMessage } =
    opts;
  const transcript: string[] = [userContent];
  let finalText = "";

  try {
    const result = streamText({
      model,
      system,
      messages: [{ role: "user", content: userContent }],
      tools,
      stopWhen: stepCountIs(stepBudget),
      abortSignal: ctx.abortSignal,
      onError: ({ error }) => {
        console.error(`[${logTag}] nested stream error (chat ${ctx.chatId}):`, error instanceof Error ? error.message : error);
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
    return { ok: false, summary: `${logTag} sub-run failed`, content: `${logTag} failed: ${message}` };
  }

  const answer = finalText.trim() || noAnswerMessage;
  transcript.push(`\n--- answer ---\n${answer}`);

  const artifact = createArtifact({
    chatId: ctx.chatId,
    projectId: ctx.projectId,
    toolCallId,
    kind: "doc",
    name: artifactName,
    meta: {},
    body: transcript.join("\n"),
  });

  const { content, truncated } = headTailTruncate(answer, answerMaxChars);
  return {
    ok: true,
    content,
    summary: summaryLabel,
    artifactId: artifact.id,
    meta: truncated
      ? {
          truncated: {
            shown: answerMaxChars,
            total: answer.length,
            unit: "bytes" as const,
            how: "the sub-agent's answer ran long — narrow the request next time",
          },
        }
      : undefined,
  };
}
